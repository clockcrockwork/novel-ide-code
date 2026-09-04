// レビュー共通成果物（snapshot）の生成。
//
// 目的: 観点によらない機械的処理（merge-base の確定・レビュー対象 diff の生成・変更ファイルの
// 分類・高リスク領域の判定）を**モデルの外**へ出し、各観点レビュアーが毎周回で同じ情報を
// 再構築しないようにする。
//
// 出力先: `$(git rev-parse --git-path agent-review)/<snapshot-id>/`
//   .git 配下に置くのは、(a) 作業ツリーに出ないため .gitignore の追加もレビュー対象汚染も
//   不要、(b) linked worktree でも --git-path が正しい場所を返す、(c) clone 単位で自然に
//   破棄される（レビュー状態の正本は従来どおり PR 本文）ため。
//
// 完全 diff（base-to-current.patch）を正本とする。観点別の圧縮 diff は作らない
// （AI 要約のみを根拠に diff を切り捨てない）。
//
// 生成物:
//   manifest.json            スナップショットのメタ情報（base / merge-base / head / dirty 等）
//   base-to-current.patch    merge-base → 現在（作業ツリー込み）の完全 diff
//   previous-to-current.patch 前回 snapshot → 現在の修正 diff（初回は空）
//   changed-files.json       変更ファイル一覧（status・分類・シグナル）
//
// 依存: node ビルトイン + classify-changes.js / review-exec-config.js（いずれも依存フリー）

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { classify, expandRenames, DESIGN_DOC_PATTERNS, RECORD_DOC_PATTERNS } from './classify-changes.js';
import {
  CONFIG_PATTERNS,
  CONVENTION_DOC_PATTERNS,
  GUARD_PATH_PATTERNS,
  HIGH_RISK_PATTERNS,
  RISK_TABLE_PATTERNS,
  SEMANTIC_DOC_MARKERS,
  SPEC_ANCHOR_PATTERNS,
  TEST_PATTERNS,
} from './review-exec-config.js';

const SNAPSHOT_DIR_NAME = 'agent-review';
const REF_NAMESPACE = 'refs/agent-review';

// 利用者の git 設定でレビュー対象が変わってはいけない。relative=true はサブディレクトリ実行時に
// 対象を部分木へ切り詰め、外のファイルが patch からも changedFiles からも消える（実測）。
// quotepath は突き合わせには不要（headerPath が解く）が、patch はレビュアーが読む正本なので
// 見出しを生のパスに保つ
const GIT_PATH_OUTPUT = [
  '-c',
  'core.quotepath=off',
  '-c',
  'diff.relative=false',
  // color.ui=always は非 TTY でも色を付ける（delta や less -R の利用者が実際に使う）。patch の
  // 全行が ESC で始まって splitPatchByFile が 0 件を返し、全ファイルが opaque＝毎周回シグナルが
  // 立つうえ、レビュアーが読む正本が ANSI 混じりになる（実測）
  '-c',
  'color.ui=false',
  // fsmonitor（Watchman / builtin daemon）が「変更なし」と答えると、tracked の改変が status・
  // stash create・patch・changedFiles・unreportedPaths のすべてから消える。assume-unchanged と
  // 同じ「git が報告自体を止める」機構だが、そちらと違い痕跡が残らず自己修復もしない
  // （敵対的レビューで実測: 3周回連続でガード骨抜きが欠落）
  '-c',
  'core.fsmonitor=',
];

// diff の中身と見出しを利用者設定から切り離す。
//   --no-ext-diff  diff.external / GIT_EXTERNAL_DIFF は patch を丸ごと 0 バイトにできる。config と
//                  環境変数の両方を打ち消す（`-c diff.external=` では環境変数を止められない）
//   --no-textconv  diff=<driver> の textconv は内容を差し替える
//   --src-prefix / --dst-prefix  mnemonicPrefix は `1/` `2/`、noprefix は接頭辞なしにして
//                  `a/` `b/` を剥がす前提を崩す。設定を1つずつ打ち消す形は追従漏れがそのまま
//                  穴になる（実例: diff.srcPrefix / dstPrefix は git 2.45 で追加）ので、
//                  **結果**（接頭辞そのもの）を固定する。同じことを1フラグで書ける
//                  --default-prefix は git 2.41 以降にしか無く、レビュー基盤に恒久的な
//                  ツールチェーン下限を作るため使わない（--src-prefix は git 1.7.2 以降）
// いずれも実測
// submodule の変更は `.gitmodules` の `ignore = all`（**PR 内のファイル**で指定できる）でも
// 利用者 config の diff.ignoreSubmodules でも消え、patch / name-status / numstat の3経路が
// 同時に縮むので hasOpaque でも検出できない完全な fail-open だった（実測）。
// diff と status の両方で打ち消す必要があるため、片方だけ更新して穴が再発しないよう定数で共有する
const GIT_SUBMODULES_VISIBLE = '--ignore-submodules=none';
const GIT_DIFF_FIXED = [
  '--no-ext-diff',
  '--no-textconv',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  GIT_SUBMODULES_VISIBLE,
];
const GIT_EXEC = {
  encoding: 'utf-8',
  maxBuffer: 256 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
};

// onFail: 'throw'（既定）/ 'null'（失敗を許す）/ 'stdout'（`--no-index` のように差分ありを
// 非ゼロで返すコマンド）。失敗時の扱い以外は全呼び出しで同じ。
// timeout は指定した呼び出しだけに効く（未指定なら execFileSync の既定＝無期限）
export function git(args, { cwd = process.cwd(), onFail = 'throw', timeout } = {}) {
  // diff 系の固定は呼び出し側の opt-in にしない。1箇所書き忘れると、その経路だけ
  // diff.external に乗っ取られる（GIT_PATH_OUTPUT と同じ保証なのに非対称だった）
  const full = args[0] === 'diff' ? ['diff', ...GIT_DIFF_FIXED, ...args.slice(1)] : args;
  try {
    // env は呼び出しごとに作る。モジュールロード時に固定すると、実行中に設定された環境変数
    // （テストが検査する GIT_EXTERNAL_DIFF 等）が git の子プロセスへ届かず、打ち消しを検査する
    // ガードテストが空振りになる（実測）。GIT_TERMINAL_PROMPT は fetch を含む全 git 呼び出しで
    // 固定する（呼び出し側の opt-in にしない。GIT_PATH_OUTPUT / GIT_DIFF_FIXED と同じ規律）
    return execFileSync('git', [...GIT_PATH_OUTPUT, ...full], {
      cwd,
      ...GIT_EXEC,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout,
    });
  } catch (err) {
    if (onFail === 'null') return null;
    // `--no-index` の「差分あり」は status 1・signal なし・code なし・**stdout 非空**で返る。
    // maxBuffer 超過（ENOBUFS）や OOM-killer の SIGKILL は非空の切り詰め stdout を伴い、
    // 「アクセスできない」は status 1 のまま stdout が空で stderr に理由が出る（いずれも実測）。
    // 空を差分なしと同一視せず、下の throw で stderr ごと報告する
    if (onFail === 'stdout' && err?.status === 1 && !err.signal && !err.code && err.stdout) {
      return err.stdout;
    }
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    throw new Error(`git ${args.join(' ')} が失敗しました: ${stderr || err.message}`, {
      cause: err,
    });
  }
}

// .git の実体（linked worktree では .git がファイルなので rev-parse を使う）。
// Windows / WSL / Linux で同じ結果になるよう、パス結合は path モジュールに任せる。
export function reviewRoot(cwd = process.cwd()) {
  const p = git(['rev-parse', '--git-path', SNAPSHOT_DIR_NAME], { cwd }).trim();
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function readIndex(root) {
  const file = join(root, 'index.json');
  if (!existsSync(file)) return { snapshots: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    // 構造不正（`{"snapshots": null}` 等）も破損と同じ扱いにする
    if (!Array.isArray(parsed?.snapshots)) throw new Error('snapshots が配列ではありません');
    return parsed;
  } catch (err) {
    // 「前回なし」へ黙ってフォールバックしない（前回 snapshot の取り違えは修正 diff を誤らせる）
    throw new Error(
      `${file} が壊れています（${err.message}）。` +
        '削除して再実行してください（前回 snapshot の情報が失われ、修正差分は全体差分になる' +
        '＝過剰トリガー・安全側）',
      { cause: err },
    );
  }
}

function writeIndex(root, index) {
  writeFileSync(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
}

const BASE_REF_CANDIDATES = ['refs/remotes/origin/main', 'refs/heads/main', 'main'];

const REMOTE_TRACKING_REF = /^refs\/remotes\/([^/]+)\/(.+)$/;

/**
 * remote-tracking な base **候補** ref（例: `refs/remotes/origin/main`）を fetch で更新する。best-effort —
 * 失敗しても呼び出し元は既存の手元 ref にフォールバックする（過大化は fail-closed 方向なので、
 * offline で snapshot 自体が止まる方が実害が大きい。`check-pr-body.js:45-57` と同じ姿勢）。
 * fetch 対象かどうかの判定もここに閉じる — remote-tracking ref でなければ `null` を返し、
 * 呼び出し側は結果を素通しするだけにする（fetch 方針を変えるとき直す場所を1箇所にする）。
 * @returns {{ref: string, status: 'ok'|'skipped'|'failed', reason: string|null} | null}
 */
function refreshBaseRef(cwd, ref) {
  const m = REMOTE_TRACKING_REF.exec(ref);
  if (!m) return null;
  const [, remote, branch] = m;
  const remotes = git(['remote'], { cwd })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  // テスト用の使い捨てリポジトリは remote 未設定が常態の経路。ここで警告すると全テストがノイズを出す
  if (!remotes.includes(remote)) return { ref, status: 'skipped', reason: 'remote が無い' };
  // refspec を明示する: 省略すると remote-tracking ref が更新されず FETCH_HEAD にしか入らない
  // （#396 で既出）。--depth を付けない: shallow 化すると merge-base が解決できなくなる
  // （check-pr-body.js:45-47 / ci.yml:63-65 と同じ根拠）。15秒は「ハングを有限で切る」ための値 —
  // 正当な低速 fetch も failed に倒れうるが、過大化より安全側（fail-closed）
  try {
    git(
      [
        'fetch',
        '--no-tags',
        '--quiet',
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ],
      { cwd, timeout: 15000 },
    );
  } catch (err) {
    // 故障モードを固定の列挙値で分類する。生の stderr は分類にだけ使い、manifest にも警告にも
    // 載せない（remote URL に資格情報が含まれうる）。前回の強制終了で残った .lock は自己修復せず
    // 以後全周回で「オフライン等」に潰れて原因へ辿れなくなる（実測）ため、単独の分岐にする
    const raw = err?.cause ?? err;
    const stderr = typeof raw?.stderr === 'string' ? raw.stderr : '';
    const reason =
      raw?.signal === 'SIGTERM'
        ? 'fetch がタイムアウトしました（15秒）'
        : /cannot lock ref|\.lock/.test(stderr)
          ? 'ref のロック競合（前回の中断が残っている可能性）'
          : 'fetch に失敗（オフライン・認証・remote 到達不能のいずれか）';
    console.warn(
      `review-snapshot: ⚠ base ref を更新できませんでした（${reason}）。` +
        '手元の ref で続行します。レビュー対象 diff が実際の PR より過大になりえます',
    );
    return { ref, status: 'failed', reason };
  }
  return { ref, status: 'ok', reason: null };
}

/**
 * base ref の解決。`--base` の明示があればそれを使う。
 *
 * 明示が無い場合、候補（origin/main・ローカル main）のうち **HEAD との merge-base が最も新しい**
 * ものを選ぶ。固定の優先順にすると、片方が stale なとき merge-base が古い方へ倒れ、レビュー対象
 * diff に**無関係な既マージ済みコミットが大量に混ざる**（実測: 4 ファイルの変更が 104 ファイルに
 * 膨らんだ）。stale はローカル main 側にも remote 追跡側にも起こりうるため、優先順ではなく
 * 「HEAD に最も近い方」を選ぶ。
 *
 * 候補の一部（remote-tracking ref）は選定前に fetch で更新する。手元の ref が stale なままだと
 * 「HEAD に最も近い方」の判定自体が古い情報に基づいてしまい、この関数の目的を達成できない（#577）。
 */
export function resolveBaseRef(cwd, requested, headSha = null) {
  if (requested) {
    // `--base origin/main` のような remote-tracking の別名指定も fetch 対象にする。
    // ref 名の文字列一致ではなく解決先で判定する（`--base` の主要な渡し方の1つに穴を残さない）。
    // fetch 対象かどうかの判定は refreshBaseRef 自身が行う（非対象なら null を返す）
    const full = git(['rev-parse', '--symbolic-full-name', requested], { cwd, onFail: 'null' });
    // single-branch clone 等で origin/main 自体が手元に無いと symbolic-full-name が解決できない
    // （exit 128・実測）。ref 名から remote-tracking ref を組み立てて fetch すれば自力で作れる
    // （既定経路と同じ回復力）。`refs/` 始まりの指定・SHA 指定は組み立てた候補が
    // REMOTE_TRACKING_REF に一致せず refreshBaseRef が null で弾くため素通しで安全
    const refs = full
      ? [full.trim()]
      : !requested.startsWith('refs/')
        ? [`refs/remotes/${requested}`]
        : [];
    const fetches = refs.map((r) => refreshBaseRef(cwd, r)).filter(Boolean);
    const sha = git(['rev-parse', '--verify', '--quiet', `${requested}^{commit}`], {
      cwd,
      onFail: 'null',
    });
    if (!sha) {
      throw new Error(`base ref を解決できません（指定: ${requested}）`);
    }
    return { ref: requested, sha: sha.trim(), fetches };
  }
  const head = headSha ?? git(['rev-parse', 'HEAD'], { cwd }).trim();
  const fetches = BASE_REF_CANDIDATES.map((ref) => refreshBaseRef(cwd, ref)).filter(Boolean);
  const resolved = [];
  for (const ref of BASE_REF_CANDIDATES) {
    const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      onFail: 'null',
    });
    if (!sha) continue;
    const mb = git(['merge-base', sha.trim(), head], { cwd, onFail: 'null' });
    if (!mb) continue; // 履歴が繋がらない ref（無関係な孤立ブランチ等）は候補にしない
    resolved.push({ ref, sha: sha.trim(), mergeBase: mb.trim() });
  }
  if (resolved.length === 0) {
    throw new Error(
      `base ref を解決できません（試行: ${BASE_REF_CANDIDATES.join(' / ')}）。--base で明示してください`,
    );
  }
  // merge-base が他候補の merge-base の子孫（＝より新しい）ものを選ぶ
  let best = resolved[0];
  for (const cand of resolved.slice(1)) {
    const bestIsAncestor =
      git(['merge-base', '--is-ancestor', best.mergeBase, cand.mergeBase], {
        cwd,
        onFail: 'null',
      }) !== null;
    if (bestIsAncestor && best.mergeBase !== cand.mergeBase) best = cand;
  }
  return { ...best, fetches };
}

export function porcelainStatus(cwd) {
  // `git diff` 側と同じ打ち消しを status にも掛ける。掛けないと:
  //   --ignore-submodules=none  `.gitmodules` の `ignore = all`（**PR 内のファイル**）で
  //     未コミットの submodule ポインタ変更が dirty 判定ごと消え、patch も changedFiles も
  //     空のまま「変更なし」の snapshot が出る（実測）
  //   core.excludesFile        利用者の**グローバル**除外設定で untracked が status から消え、
  //     changedFiles にも patch にも痕跡が残らない＝ hasOpaque でも拾えない（実測）。
  //     リポジトリ内の `.gitignore` は打ち消さない（生成物の除外は正当な設定）
  const out = git(
    [
      '-c',
      'core.excludesFile=/dev/null',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      GIT_SUBMODULES_VISIBLE,
    ],
    { cwd },
  );
  const parts = out.split('\0');
  const untracked = [];
  const tracked = [];
  let dirty = false;
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === '??') {
      untracked.push(path);
      dirty = true;
      continue;
    }
    dirty = true;
    tracked.push(path);
    // rename/copy は「-z 形式で次のエントリが旧パス」なので読み飛ばす
    if (code[0] === 'R' || code[0] === 'C') i += 1;
  }
  return { dirty, untracked: untracked.sort(), tracked: tracked.sort() };
}

/**
 * 現在の状態（作業ツリー込み）を指すコミットを作る。
 * clean なら HEAD、dirty なら `git stash create`（作業ツリーを変更せずコミットオブジェクトだけ
 * 作る）を使い、`refs/agent-review/<id>` で参照可能にして gc から守る。
 * untracked ファイルは stash create に含まれないため、patch には別途 --no-index で追記する。
 */
function materializeCurrent(cwd, snapshotId, dirty) {
  const head = git(['rev-parse', 'HEAD'], { cwd }).trim();
  if (!dirty) return { commit: head, head, ref: null };
  const created = git(['stash', 'create'], { cwd }).trim();
  // index も worktree も HEAD と同一（untracked のみ dirty）の場合、stash create は空を返す
  const commit = created || head;
  let ref = null;
  if (created) {
    ref = `${REF_NAMESPACE}/${snapshotId}`;
    git(['update-ref', ref, created], { cwd });
  }
  return { commit, head, ref };
}

// `--name-status -z` の NUL 区切り出力を読む。`-z` を外すと `"` / バックスラッシュ /
// 制御文字を含むパスが C クォートされたまま届き（`core.quotepath=off` では防げない。実測）、
// パス正規表現（HIGH_RISK_PATTERNS 等）が外れて `worker/a"b.js` が highRisk:false へ落ちる。
// rename の旧パス・新パスの分離も -z が構造的に解決する
export function parseNameStatus(out) {
  const tokens = out.split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    const kind = status[0];
    const consumed = kind === 'R' || kind === 'C' ? 2 : 1;
    const paths = tokens.slice(i + 1, i + 1 + consumed);
    // 期待どおりのレコードが揃わない場合は fail-loud。break で打ち切ると残りの変更ファイルが
    // changed-files から黙って消え、この PR が塞いだ「変更が分類器を素通りする」失敗様式を
    // 別経路で再導入する（readIndex の構造不正・EEXIST と同じ方針）
    if (paths.length < consumed || paths.some((path) => !path)) {
      throw new Error(
        `git diff --name-status -z の出力が想定外です（status=${status} の後にパスがありません）。` +
          'git のバージョン差の可能性があるため、再現する場合はこの出力を添えて報告してください',
      );
    }
    files.push(
      consumed === 2
        ? { path: paths[1], oldPath: paths[0], status: kind }
        : { path: paths[0], status: kind },
    );
    i += consumed;
  }
  return files;
}

// `--numstat -z` は通常 `add\tdel\tpath`、rename では `add\tdel\t` の直後に
// 旧パス・新パスが別レコードで続く（実測）
export function parseNumstat(out) {
  const tokens = out.split('\0');
  const stats = new Map();
  const toCount = (v) => (v === '-' ? null : Number.parseInt(v, 10)); // バイナリは `-`
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i]) continue;
    // パス部分は正規表現で拾わない（`.` が LF/CR/U+2028/U+2029 を含まず、それらのパスの
    // レコードが丸ごと外れる）。想定外トークンの読み飛ばしも含め、規模シグナルが黙って
    // 欠けるのが最悪の失敗なので throw する（parseNameStatus と同じ方針）
    const m = /^(-|\d+)\t(-|\d+)\t/.exec(tokens[i]);
    if (!m) {
      throw new Error(
        `git diff --numstat -z の出力が想定外です（${tokens[i]}）。` +
          'git のバージョン差の可能性があるため、再現する場合はこの出力を添えて報告してください',
      );
    }
    const counts = { additions: toCount(m[1]), deletions: toCount(m[2]) };
    const path = tokens[i].slice(m[0].length);
    if (path !== '') {
      stats.set(path, counts);
      continue;
    }
    const newPath = tokens[i + 2];
    if (!newPath) {
      throw new Error('git diff --numstat -z の出力が想定外です（rename のパスがありません）');
    }
    stats.set(newPath, counts);
    i += 2;
  }
  return stats;
}

function matchesAny(path, patterns) {
  return patterns.some((re) => re.test(path));
}

/**
 * ファイル1件の分類。classify-changes.js の判定を単一ファイルへ適用して整合を保つ。
 *
 * 注意: 「依存 manifest **のみ**の変更か」（classify の depOnly）は変更**集合**に対する判定で、
 * 1ファイルだけでは決まらない（package.json 単体は lockfile が動いていないと depOnly にならない）。
 * ここで返す `dep` は「このファイルが依存 manifest か」であり、Tier 判定側（computeInitialTier）は
 * 集合に対して classify() を呼び直す。
 *
 * oldPath（rename 元のパス）は classify 入力に含める（表示上は path/oldPath を維持したまま、
 * 「code だった rename 元 → prose に見える rename 先」で分類だけが軽く見える密輸経路を塞ぐ。
 * `git diff --find-renames` を無効化すると rename 表示自体が失われるため、CI 側〔#446〕の
 * `--no-renames` とは異なるアプローチを採る。#446 round2 観点別レビュー）。
 * design/record/test/config 等の path パターン判定は rename 先の表示パスのみを対象とする
 * （こちらは実行可能拡張子の密輸問題とは無関係のため対象を広げない）。
 */
export function classifyFile(path, oldPath) {
  // oldPath の合成は classify-changes.js の expandRenames に統合済み（#446 round4 減算#4）。
  const { codeChanged, depsChanged } = classify(expandRenames([{ path, oldPath }]));
  const isDesign = matchesAny(path, DESIGN_DOC_PATTERNS);
  const isRecord = matchesAny(path, RECORD_DOC_PATTERNS);
  const isTest = matchesAny(path, TEST_PATTERNS);
  const isConfig = matchesAny(path, CONFIG_PATTERNS);
  let kind;
  if (isTest) kind = 'test';
  else if (depsChanged) kind = 'dep';
  else if (isRecord) kind = 'docs-record';
  else if (isDesign) kind = 'docs-design';
  else if (!codeChanged) kind = 'docs-other';
  else if (isConfig) kind = 'config';
  else kind = 'code';
  return {
    kind,
    code: codeChanged && !isTest,
    designDoc: isDesign,
    recordDoc: isRecord,
    test: isTest,
    config: isConfig && codeChanged,
    dep: depsChanged,
    highRisk: matchesAny(path, HIGH_RISK_PATTERNS),
    guardPath: matchesAny(path, GUARD_PATH_PATTERNS),
    conventionDoc: matchesAny(path, CONVENTION_DOC_PATTERNS),
    specAnchor: matchesAny(path, SPEC_ANCHOR_PATTERNS),
    riskTable: matchesAny(path, RISK_TABLE_PATTERNS),
  };
}

// ガード種（正規表現・バリデーション・分類器）の変更を patch 本文から検出する。
// パス（scripts/agent 等）だけでは「コメント修正」まで拾うため、追加/削除行の内容も見る。
const GUARD_CONTENT_RE =
  /(^[+-].*\/(?:[^/\n\\]|\\.){2,}\/[gimsuyv]*\s*[,;)\]]?\s*$)|^[+-].*\b(new RegExp|\.test\(|\.match\(|\.exec\(|validate|sanitize|classif|allowlist|denylist|escapeHtml|assertValid)/im;

export function detectGuardChange(patch, changedFiles) {
  // 空 patch で早期 return しない。untracked の非通常ファイルだけが変わった周回は patch が
  // 空・changedFiles が非空になり、早期 return があると hasOpaque へ到達せず fail-open した
  // （実測）。変更が無い周回は changedFiles も空なので hasOpaque が false を返す
  if (
    patch
      .split('\n')
      .some((line) => (line.startsWith('+') || line.startsWith('-')) && GUARD_CONTENT_RE.test(line))
  ) {
    return true;
  }
  // 内容が読めない変更は「ガード変更なし」と証明できない。種別も status も問わない
  // （`code` に絞ると test / docs 配下の dep がどちらの opaque 集合にも入らず、
  // `tests/** -diff` でテストを潰す経路が残る。実測）
  return hasOpaque(patch, changedFiles);
}

/**
 * 設計文書の「意味的変更」検出。誤字修正と、拘束力のある記述の変更を区別する。
 *
 * **fail-closed**: 意味的変更が無いと**証明できる**場合のみ false。
 * 証明の条件は「prose の追加/削除行がいずれも SEMANTIC_DOC_MARKERS を含まず、
 * かつ構造（見出し・表行・箇条書き・番号付き手順）を動かしていない」こと。
 */
export function detectSemanticDocChange(patch, changedFiles) {
  const proseFiles = changedFiles.filter(
    (f) => f.designDoc || f.recordDoc || f.kind === 'docs-other',
  );
  if (proseFiles.length === 0) return false;
  // ファイルの追加・削除・改名は常に意味的変更（新しい成果物・規則・役割の追加/撤去）。
  // untracked（U）も新規成果物なので同じ扱いにする — 外すと「コミットしないだけ」で
  // 新しい設計文書の追加がシグナルを回避できる（実測）
  const NEW_OR_GONE = new Set(['A', 'D', 'R', 'U']);
  if (proseFiles.some((f) => NEW_OR_GONE.has(f.status))) return true;
  // 内容が読めないファイルは「意味的変更が無い」と証明できない。patch が空の場合も
  // prose ファイルが1件でもあれば全件が読めない扱いになるので、ここが fail-closed の唯一の根拠
  if (hasOpaque(patch, proseFiles)) return true;
  const proseSet = new Set(proseFiles.map((f) => f.path));
  for (const { path, lines } of splitPatchByFile(patch)) {
    if (!proseSet.has(path)) continue;
    for (const line of lines) {
      const body = line.slice(1);
      if (!body.trim()) continue;
      if (SEMANTIC_DOC_MARKERS.some((mk) => body.includes(mk))) return true;
      // 構造行（見出し・表行・箇条書き・番号付き手順）の増減は意味的変更として扱う
      if (/^\s*(#{1,6}\s|[-*]\s|\d+[.)]\s|\|)/.test(body)) return true;
    }
  }
  return false;
}

const C_ESCAPES = { t: 9, n: 10, r: 13, f: 12, b: 8, v: 11, a: 7, '"': 34, '\\': 92 };

/**
 * `--- ` / `+++ ` 行のパス欄を生のパスへ戻す。
 *
 * git は特殊文字を含むパスを C クォートし（`core.quotepath=off` を渡しても `"` /
 * バックスラッシュ / 制御文字は対象）、空白を含むパスの後ろには TAB 区切りを足す。
 * 素直に行末まで取ると TAB が混ざり、trim すると末尾空白を含むパスが別物になる。
 * どちらも changedFiles の生パスと突き合わなくなり、detectSemanticDocChange が
 * そのファイルを1行も検査しないまま false を返す（実測）。
 */
export function headerPath(rest) {
  if (!rest.startsWith('"')) {
    const tab = rest.indexOf('\t');
    return tab === -1 ? rest : rest.slice(0, tab);
  }
  const enc = new TextEncoder();
  const bytes = [];
  let closed = false;
  for (let i = 1; i < rest.length; i += 1) {
    const c = rest[i];
    if (c === '"') {
      closed = true;
      break;
    }
    if (c !== '\\') {
      bytes.push(...enc.encode(c));
      continue;
    }
    const esc = rest[i + 1];
    // エスケープ未完のバックスラッシュ。git の C クォートは必ず閉じるため想定外入力。
    // 姉妹パーサ（parseNameStatus / parseNumstat）と同じく、黙って切り詰めず throw する
    if (esc === undefined) throw new Error(`不正な C クォートパス（エスケープ未完）: ${rest}`);
    if (esc >= '0' && esc <= '7') {
      bytes.push(Number.parseInt(rest.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(...(esc in C_ESCAPES ? [C_ESCAPES[esc]] : enc.encode(esc)));
      i += 1;
    }
  }
  if (!closed) throw new Error(`不正な C クォートパス（閉じ引用符なし）: ${rest}`);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/**
 * patch から内容を読み取れなかった変更ファイルがあるか。
 *
 * 属性（`-diff` / `diff=<driver>` + `binary=true`）で binary 表現へ潰されたファイルは
 * `+++` 見出しを持たないため patch から消える。属性値を見て判定すると、`unset` 以外の
 * 書き方で素通りし（実測）、逆に実バイナリ資産の `binary` 属性で誤って止まる。
 * 「読める内容があるか」で見れば、潰し方によらず拾えて実バイナリだけを止めずに済む。
 */
function hasOpaque(patch, files) {
  if (files.length === 0) return false;
  const readable = new Set(splitPatchByFile(patch).map((f) => f.path));
  return files.some((f) => !readable.has(f.path));
}

/**
 * unified diff をファイル単位の追加/削除行へ分解する。
 * ファイル名は `+++ b/<path>` を正とし、削除ファイル（`+++ /dev/null`）は `--- a/<path>` を使う。
 */
export function splitPatchByFile(patch) {
  const out = [];
  let cur = null;
  let pendingOld = null;
  // 末尾空白はパスの一部でありうるので trim しない（CRLF の \r だけ落とす）
  const pathOf = (line, prefix) => headerPath(line.slice(4).replace(/\r$/, '')).replace(prefix, '');
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null;
      pendingOld = null;
      continue;
    }
    // 見出しは `diff --git` の直後にしか現れない（＝ cur がまだ立っていない区間）。行頭だけで
    // 判定すると、`++ ` で始まる**内容行**が patch 上で `+++ ` になって幽霊ファイル見出しに化け、
    // 以降の行が実パスの検査対象から外れる（実測: 設計文書への拘束力ある追記が false へ落ちた）
    if (!cur && line.startsWith('--- ')) {
      const p = pathOf(line, /^a\//);
      pendingOld = p === '/dev/null' ? null : p;
      continue;
    }
    if (!cur && line.startsWith('+++ ')) {
      const p = pathOf(line, /^b\//);
      const path = p === '/dev/null' ? pendingOld : p;
      cur = { path, lines: [] };
      if (path) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') || line.startsWith('-')) cur.lines.push(line);
  }
  return out;
}

/**
 * untracked ファイルの内容を unified diff として生成する。
 * `git stash create` は untracked を含まないため、完全 diff を正本にするにはこの追記が要る
 * （untracked を無条件にレビュー対象外へ出さない）。
 *
 * 左オペランドを `/dev/null` にして、見出し（`diff --git` / `new file mode` / `+++ b/<path>`）を
 * **git 自身に生成させる**。手書きで組み立てると、git のクォート規則（TAB を含むパスは
 * `"b/src/a\\tb.js"`）を再実装しそこねて splitPatchByFile と突き合わなくなる（実測）。
 * パスはリポジトリ相対のままルートで解決する（サブディレクトリ実行で実ファイルに当たらず、
 * 内容が patch から消えた。実測）
 */
function untrackedPatch(root, untracked) {
  const chunks = [];
  const skipped = [];
  for (const path of untracked) {
    // `--no-index` は対象がディレクトリ実体（ディレクトリへの symlink 等）だと basename を
    // 繋いだ**別ファイル**の diff を返す（実測: `assets` → `assets/null`）。出力側の検証は
    // 見出しを持たない decoy（バイナリ・空ファイル）で素通りするため、入口で型を確かめる
    let stat;
    try {
      stat = lstatSync(join(root, path));
    } catch {
      // 非 UTF-8 のファイル名は argv へ戻す時点で U+FFFD に潰れ、実ファイルに当たらない。
      // ここで throw すると、レビュー対象と無関係な stray ファイル1個で全レビューの入口
      // （review:snapshot）が止まり、回避策が「除外設定で隠す」＝対象を黙って落とす方向に
      // なる。symlink と同じく unreportedPaths へ回して fail-closed のまま先へ進む
      skipped.push(path);
      continue;
    }
    // 通常ファイル以外（symlink・ディレクトリ）は `--no-index` が basename を繋いだ別ファイルの
    // diff を返す（実測: `assets` → `assets/null`）。patch へ載せず manifest.unreportedPaths へ
    // 回す — レビュアーは正本 patch を読むので、落ちた対象を成果物から復元できる必要がある。
    // ここで throw すると untracked の symlink 1本でレビュー基盤全体が止まる
    if (!stat.isFile()) {
      skipped.push(path);
      continue;
    }
    const out = git(['diff', '--no-index', '--binary', '--', '/dev/null', path], {
      cwd: root,
      onFail: 'stdout',
    });
    chunks.push(out);
  }
  return { patch: chunks.join(''), skipped };
}

// `git update-index --assume-unchanged` / `--skip-worktree` が立った tracked ファイルは、
// 作業ツリーを書き換えても status にも stash create にも現れない（実測: dirty=false /
// changedFiles=0 / patch=0 バイト）。フラグを解除して commit すれば未レビューのまま出荷できる。
// untracked の内容ハッシュ。ディレクトリ・読めないものは unreportedPaths 経由で
// fail-closed に倒れるため、ここでは黙って落としてよい。
// 動的キー（利用者由来のパス）を持つので Object.create(null) で初期化する（INVARIANTS #11）
export function untrackedContentHashes(worktreeRoot, paths) {
  const hashes = Object.create(null);
  for (const p of paths) {
    try {
      const st = lstatSync(join(worktreeRoot, p));
      // symlink は**リンク先の内容ではなく symlink 自身の identity**（リンク先文字列）を
      // 指紋にする。readFileSync はリンクを辿るため、内容をハッシュすると「patch に一度も
      // 載っていない内容」が台帳に残り、次周回に同内容の実ファイルへ差し替わると
      // 「既知＝未変更」と判定される（運用性レビューで実測）。
      // かといって対象から外すと、リンク先だけ差し替えても集合も内容も同じと判定され、
      // コミット可能な変更がレビュー済み扱いで受理される（外部レビュー Codex 指摘）。
      // type を接頭辞で区別し、通常ファイルの既存ハッシュ形式は壊さない
      if (st.isSymbolicLink()) {
        hashes[p] = `symlink:${createHash('sha256')
          .update(readlinkSync(join(worktreeRoot, p)))
          .digest('hex')}`;
        continue;
      }
      if (!st.isFile()) continue;
      hashes[p] = createHash('sha256')
        .update(readFileSync(join(worktreeRoot, p)))
        .digest('hex');
    } catch {
      // 読めない＝unreportedPaths 側で拾われる
    }
  }
  return hashes;
}

/**
 * 作業ツリーの差し替えを拒否する。
 *
 * `GIT_WORK_TREE` / `core.worktree` は作業ツリーを別ディレクトリへ差し替える。git はそちらを
 * 見て「clean」と答えるため、レビュー対象の改変も untracked も痕跡ゼロで消える
 * （dirty=false / unreportedPaths=[] / 全シグナル false。敵対的レビューで実測）。
 *
 * 「ルートが cwd を含むか」という**結果**の検査では足りない — ルートも cwd も攻撃者が
 * 選べるため、差し替え先を cwd の祖先に置く／cwd を差し替え先へ移すだけで通過する（実測）。
 * よって機構そのものを拒否する。通常の作業ツリーも linked worktree（`git worktree add`）も
 * どちらも設定しないため、正当な使い方を壊さない（実測）。
 *
 * **snapshot 生成と鮮度検証の双方から呼ぶ**。同一の入力クラス（作業ツリーが snapshot 時点から
 * 動いていないか）を判定する2実装の受理集合が非対称だと、片方を迂回するだけで古い結果が
 * 受理される（外部レビュー Codex 指摘 / #572。鮮度側だけガードが無く、改変済みツリーに対する
 * `record-run` を実際に受理させられた）
 */
function assertNoWorktreeSubstitution(cwd) {
  if (process.env.GIT_WORK_TREE !== undefined) {
    throw new Error(
      'GIT_WORK_TREE が設定されています。作業ツリーが差し替えられると、レビュー対象の改変が' +
        '痕跡なく消えます。解除してから再実行してください',
    );
  }
  if (git(['config', '--get', 'core.worktree'], { cwd, onFail: 'null' }) !== null) {
    throw new Error(
      'core.worktree が設定されています。作業ツリーが差し替えられると、レビュー対象の改変が' +
        '痕跡なく消えます。解除してから再実行してください',
    );
  }
  // 上の2経路以外で差し替えられた場合の保険（多重防御）
  const worktreeRoot = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  const realRoot = realpathSync(worktreeRoot);
  const realCwd = realpathSync(cwd);
  if (realCwd !== realRoot && !realCwd.startsWith(`${realRoot}${sep}`)) {
    throw new Error(
      `作業ツリーのルート（${worktreeRoot}）が実行ディレクトリ（${cwd}）を含みません`,
    );
  }
}

// `ls-files -v` のタグは大文字 `H` が通常で、小文字＝assume-unchanged・`S`＝skip-worktree。
// `--full-name -- :/` が要る: パススペック無指定だと cwd 配下しか返さず、サブディレクトリ実行で
// cwd の外のフラグ付きファイルが丸ごと見えなくなる（＝隠された改変が「変更なし」で通る fail-open）。
// 返るパスも cwd 相対になり、classifyFile が worker/ を highRisk と判定できなくなる（実測）
export function suppressedPaths(cwd) {
  const out = git(['ls-files', '-v', '-z', '--full-name', '--', ':/'], { cwd });
  const paths = [];
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tag = entry[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) paths.push(entry.slice(2));
  }
  return paths;
}

// `git stash create` は `.gitmodules` の `ignore = all` を尊重するため、status が dirty と
// 報告した tracked パスが具現化コミットへ入らないことがある（実測: 未コミットの submodule
// ポインタ変更で stash create が空を返し、patch も changedFiles も空になった）。設定の値を
// 数え上げるのではなく、**status が見えると言ったものが具現化コミットに入っているか**を見る
function unmaterializedPaths(cwd, tracked, head, commit) {
  if (tracked.length === 0) return [];
  const captured =
    commit === head
      ? []
      : git(['diff', '--name-only', '-z', head, commit], { cwd }).split('\0').filter(Boolean);
  const seen = new Set(captured);
  return tracked.filter((p) => !seen.has(p));
}

// 変更ファイルの一覧は「PR 全体」と「修正差分」の2箇所で取る。同じ形で取らないと、
// 片方だけにフラグを足した時に無言で仕様が乖離する（`-z` の付け忘れが実際に起きた）
function classifiedNameStatus(cwd, fromSha, toSha) {
  return parseNameStatus(
    git(['diff', '--name-status', '--find-renames', '-z', fromSha, toSha], { cwd }),
  ).map((f) => ({ ...f, ...classifyFile(f.path, f.oldPath) }));
}

function diffPatch(cwd, fromSha, toSha) {
  return git(['diff', '--binary', '--find-renames', fromSha, toSha], { cwd });
}

// dirty な snapshot ごとに `refs/agent-review/<id>` を作る（stash create のコミットを gc から守る）。
// レビューループは長いと十数周になるため、放置すると到達可能な dead ref が溜まり続ける。
// 直近 KEEP_REFS 件だけ残す（それより古い snapshot の修正 diff を後から取り直す用途は無い）。
const KEEP_REFS = 3;

function pruneRefs(cwd, index) {
  const stale = index.snapshots.slice(0, -KEEP_REFS).filter((s) => s.ref);
  for (const s of stale) {
    git(['update-ref', '-d', s.ref], { cwd, onFail: 'null' });
    s.ref = null;
  }
}

/**
 * snapshotId を決め、出力先ディレクトリを確保する。
 *
 * snapshotId は**生成回の identity**。一意性は UUID だけが担保し、連番・HEAD・dirty は人間向けの
 * 接頭辞にすぎない。削除されうる成果物（index・ディレクトリ・台帳）から復元した連番に一意性を
 * 負わせると、それらを失った時に消化済み snapshotId が再生成され、台帳の起動記録が未レビューの
 * diff を「実施済み」にする（実測）。
 */
function allocateSnapshotDir(cwd, root, seq, dirty) {
  const headShort = git(['rev-parse', '--short', 'HEAD'], { cwd }).trim();
  const snapshotId = `${String(seq).padStart(4, '0')}-${headShort}${dirty ? '-dirty' : ''}-${randomUUID()}`;
  const dir = join(root, snapshotId);
  try {
    // recursive: true は既存ディレクトリを黙って受け入れる。既存 snapshot を上書きしないことは
    // 生成器の独立した保証なので、識別子の作り方によらず EEXIST で落とす
    mkdirSync(dir);
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    throw new Error(
      `snapshot の出力先が既にあります（${snapshotId}）。` +
        '識別子は毎回新しく作るため通常は起こらない。同名の残骸を取り除いてください',
      { cause: err },
    );
  }
  return { snapshotId, dir };
}

/**
 * snapshot を1つ生成する。
 * @returns {{snapshotId: string, dir: string, manifest: object, changedFiles: object[]}}
 */
export function createSnapshot({ cwd = process.cwd(), baseRef = null, now = new Date() } = {}) {
  const root = reviewRoot(cwd);
  mkdirSync(root, { recursive: true });
  const index = readIndex(root);
  const previous = index.snapshots[index.snapshots.length - 1] ?? null;

  const headForBase = git(['rev-parse', 'HEAD'], { cwd }).trim();
  const base = resolveBaseRef(cwd, baseRef, headForBase);
  const { dirty, untracked, tracked } = porcelainStatus(cwd);
  const seq = index.snapshots.length + 1;
  const { snapshotId, dir } = allocateSnapshotDir(cwd, root, seq, dirty);

  // untracked のパスはリポジトリ相対なので、解決の基準は cwd ではなくワークツリーのルート
  const worktreeRoot = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
  assertNoWorktreeSubstitution(cwd);
  const current = materializeCurrent(cwd, snapshotId, dirty);
  const mergeBase = git(['merge-base', base.sha, current.commit], { cwd }).trim();

  const allUntracked = untrackedPatch(worktreeRoot, untracked);
  const baseToCurrent = diffPatch(cwd, mergeBase, current.commit) + allUntracked.patch;
  // 前回 snapshot が無い初回は「修正差分」が存在しない（＝全体が新規）。空文字列にして
  // 「修正差分が空」と「初回」を manifest.previousSnapshotId で区別できるようにする
  const prevCommit = previous?.commit ?? null;
  // untracked は commit 化されないため snapshot 間で diff が取れない。修正差分へ**毎回**
  // 全量を足すと、同じ untracked ファイルが毎周回「新規」として現れ、changed-files.json の
  // changedInFix（untracked を含まない）と食い違う。前回 snapshot に無かったものだけを足す
  // untracked は commit 化されないため、台帳がパスしか持たないと**内容の書き換え**と**削除**が
  // 修正差分・changedInFix・全シグナルから消え、review-plan が「修正差分ゼロ」で全観点を skip
  // する（敵対的レビューで実測: untracked のガードを無効化しても誰もレビューしないまま収束）。
  // 内容ハッシュを台帳に残し、パスが同じでも中身が変われば「新規」と同じ扱いにする
  const untrackedHashes = untrackedContentHashes(worktreeRoot, untracked);
  const prevHashes = previous?.untrackedHashes ?? null;
  const newUntracked = untracked.filter((p) => {
    if (!(previous?.untracked ?? []).includes(p)) return true;
    // ハッシュが無い（旧形式の台帳・前周回は読めなかった）ものを「未変更」と断定しない。
    // 「読めないものは unreportedPaths が拾う」は**同じ snapshot 内でしか成立しない** —
    // 次の周回で読める実ファイルに差し替わると fail-closed の網も外れ、ガードを無効化した
    // 内容が誰にもレビューされないまま収束する（減算レビューで実測）。安全側＝新規扱いに倒す
    return prevHashes?.[p] !== untrackedHashes[p];
  });
  // 消えた untracked は patch を作れない（内容が無い）ので changedInFix へ status 'D' で載せる
  const deletedUntracked = (previous?.untracked ?? []).filter((p) => !untracked.includes(p));
  const previousToCurrent = prevCommit
    ? diffPatch(cwd, prevCommit, current.commit) + untrackedPatch(worktreeRoot, newUntracked).patch
    : '';

  const numstat = parseNumstat(
    git(['diff', '--numstat', '--find-renames', '-z', mergeBase, current.commit], { cwd }),
  );
  const changedFiles = classifiedNameStatus(cwd, mergeBase, current.commit).map((f) => ({
    ...f,
    ...(numstat.get(f.path) ?? { additions: null, deletions: null }),
  }));
  for (const path of untracked) {
    changedFiles.push({
      path,
      status: 'U',
      additions: null,
      deletions: null,
      ...classifyFile(path),
    });
  }
  // 「作業ツリーの状態を検査できなかった」パス。3経路とも patch に載らない:
  //   - status が dirty と言ったのに具現化コミットへ入らなかった（submodule の未コミット変更）
  //   - git が報告自体を止められている（assume-unchanged / skip-worktree）
  //   - 通常ファイルでないため `--no-index` に掛けられなかった untracked（symlink・ディレクトリ）
  // hasOpaque は「patch に見出しが無い」ことで判定するが、**コミット済みの内容が読める**
  // ファイルの作業ツリー変更が隠された場合は見出しが存在するため拾えない（実測）。
  // 検査できなかったこと自体をシグナルの根拠にする
  const unreportedPaths = [
    ...new Set([
      ...unmaterializedPaths(cwd, tracked, current.head, current.commit),
      ...suppressedPaths(cwd),
      ...allUntracked.skipped,
    ]),
  ].sort();
  const knownPaths = new Set(changedFiles.map((f) => f.path));
  const opaqueEntries = unreportedPaths
    .filter((path) => !knownPaths.has(path))
    .map((path) => ({
      path,
      status: 'M',
      additions: null,
      deletions: null,
      ...classifyFile(path),
    }));
  changedFiles.push(...opaqueEntries);
  changedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 修正差分の変更ファイル。`git diff` は untracked を含まないため、previous-to-current.patch へ
  // 追記した新規 untracked を**ここにも**載せる。patch と changedInFix がずれると、
  // deriveSignals / detectSemanticDocChange が「修正差分に新規ファイルが増えた」を見落とし、
  // 再探索トリガーが誤って skip になる（fail-open。外部レビュー指摘で実測: 新規 untracked の
  // 設計文書を足した周回で changedInFix が空になり semanticDocChangeInFix が false へ落ちた）
  const fixTracked = prevCommit ? classifiedNameStatus(cwd, prevCommit, current.commit) : [];
  // **commit 差分に載っているパスは untracked 側から足さない**（1パス1エントリ）。
  // `git add` してコミットしただけのパスが 'A' と 'D' の二重になり、削除していないのに
  // `deletion` が立つ（累積側は同じ規律で塞いである。敵対的 F5 が実測）
  const fixTrackedPaths = new Set(fixTracked.map((f) => f.path));
  const untrackedEntry = (path, status) => ({ path, status, ...classifyFile(path) });
  const changedInFix = prevCommit
    ? [
        ...fixTracked,
        ...newUntracked
          .filter((path) => !fixTrackedPaths.has(path))
          .map((path) => untrackedEntry(path, 'U')),
        ...deletedUntracked
          .filter((path) => !fixTrackedPaths.has(path))
          .map((path) => untrackedEntry(path, 'D')),
        // 具現化できなかった変更は「前回との差分が取れたか」も判定できないため、
        // 解消されるまで毎周回シグナルを立てる（設定を直せば消える）
        ...opaqueEntries,
      ]
    : changedFiles;

  // シグナル判定の材料は**修正差分**。前回 snapshot がある場合は previous-to-current だけを見る。
  // 空のときに base-to-current へフォールバックすると「何も変わっていない周回」でも PR 全体の
  // シグナルが立ち、再探索が無限に再トリガーされる（ドッグフードで実測: 修正ゼロの周回に
  // guard シグナルが立ち、敵対的が全体再探索へ引き上がった）。
  // 前回 snapshot が無い初回のみ、PR 全体が「変更分」なので base-to-current を使う
  const fixPatch = prevCommit ? previousToCurrent : baseToCurrent;

  const manifest = {
    version: 1,
    snapshotId,
    seq,
    createdAt: now.toISOString(),
    cwd,
    baseRef: base.ref,
    baseSha: base.sha,
    // base **候補**（remote-tracking のみ）の fetch 結果。実際に選ばれた base とは限らない
    // （選ばれた base がローカル ref でも配列自体は候補分だけ残る）。stale base の診断材料（#577）
    baseFetch: base.fetches,
    mergeBase,
    headSha: current.head,
    // 作業ツリー込みの「現在」を指すコミット（dirty のとき HEAD と異なる）
    currentCommit: current.commit,
    currentRef: current.ref,
    dirty,
    untracked,
    previousSnapshotId: previous?.snapshotId ?? null,
    previousCommit: prevCommit,
    // 検査できなかったパス（上記 unreportedPaths）。レビュアーが正本 patch だけを読んでも
    // 「何が落ちたか」を成果物から復元できるようにする
    unreportedPaths,
    // 検査できなかった変更が1つでもあれば「変更なし」と証明できない（fail-closed）
    guardChangeInFix: unreportedPaths.length > 0 || detectGuardChange(fixPatch, changedInFix),
    semanticDocChangeInFix:
      unreportedPaths.length > 0 || detectSemanticDocChange(fixPatch, changedInFix),
    counts: {
      changedFiles: changedFiles.length,
      untracked: untracked.length,
    },
  };

  writeFileSync(join(dir, 'base-to-current.patch'), baseToCurrent);
  writeFileSync(join(dir, 'previous-to-current.patch'), previousToCurrent);
  writeFileSync(
    join(dir, 'changed-files.json'),
    `${JSON.stringify({ snapshotId, files: changedFiles, changedInFix }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  index.snapshots.push({
    snapshotId,
    seq,
    commit: current.commit,
    createdAt: manifest.createdAt,
    ref: current.ref,
    untracked,
    untrackedHashes,
  });
  pruneRefs(cwd, index);
  writeIndex(root, index);

  return { snapshotId, dir, manifest, changedFiles };
}

/**
 * snapshot を取った時点と現在で、レビュー対象の状態が同一か。
 *
 * record-run が古い snapshot に対する結果を受理すると、既に変わってしまった内容に対する
 * レビューを「実施済み」として台帳へ残せる（バッチ中に修正を入れた周回で実際に起きる）。
 *
 * 正本は **HEAD + 作業ツリー**。snapshot の manifest が実際に持っているのは
 * `headSha` / `currentCommit` / `untracked` で、`branch` は持たない（持たないものを
 * 判定条件にはできない）。`currentCommit` は dirty なら `git stash create` の一時コミット、
 * clean なら HEAD なので、これとの diff が空であることが tracked 側の同一性になる。
 * untracked は #570 で台帳へ入れた**内容ハッシュ**まで比較する — パス集合だけだと
 * 「同じ名前のまま中身を書き換える」が素通りする（#570 が塞いだのと同じ失敗様式）。
 */
export function snapshotFreshness(snap, cwd = process.cwd()) {
  const manifest = snap?.manifest;
  // 鮮度の証明に必要な材料が欠けている場合を「内容が変わった」と誤診断しない。ただし
  // **検査できないから通す**のは禁止 — 証明できないなら受理しない（fail-closed）。
  // 取り直しても解消しない恒久 fail-closed と区別できるよう、別の事象として報告する
  const missing = [];
  if (!manifest || typeof manifest !== 'object') missing.push('manifest');
  else {
    if (typeof manifest.currentCommit !== 'string') missing.push('currentCommit');
    if (typeof manifest.headSha !== 'string') missing.push('headSha');
    if (!Array.isArray(manifest.untracked)) missing.push('untracked');
  }
  if (missing.length > 0) {
    throw new Error(
      `snapshot=${snap?.snapshotId} の manifest から鮮度を証明できません` +
        `（欠落: ${missing.join(' / ')}）。この snapshot に対する結果は受理できません`,
    );
  }
  // `git diff` は index の抑止フラグ（assume-unchanged / skip-worktree）が立った tracked の
  // 改変を報告しない。createSnapshot は同じ機構を unreportedPaths で fail-closed に倒して
  // いるのに、鮮度側だけが「変わっていない」と断定すると**同一入力に対して2実装が正反対の
  // 判定**を出す（敵対的レビューで実測: 隠した改変に対し freshness は fresh、snapshot 側は
  // guardChangeInFix=true）。証明できない以上は受理しない
  // 作業ツリーの差し替えは createSnapshot と同じ helper で拒否する（受理集合を揃える）
  assertNoWorktreeSubstitution(cwd);
  const suppressed = suppressedPaths(cwd);
  if (suppressed.length > 0) {
    throw new Error(
      `index の抑止フラグ（assume-unchanged / skip-worktree）が立っているため鮮度を証明できません: ` +
        `${suppressed.join(' / ')}\n` +
        'git update-index --no-assume-unchanged / --no-skip-worktree で解除してから記録してください',
    );
  }
  const stale = [];
  const headSha = git(['rev-parse', 'HEAD'], { cwd }).trim();
  if (manifest.headSha !== headSha) stale.push('HEAD が変わった');
  // 作業ツリー（tracked）: 具現化コミットとの diff が空でなければ内容が動いている
  const diff = git(['diff', '--quiet', manifest.currentCommit], { cwd, onFail: 'null' });
  if (diff === null) stale.push('tracked の作業ツリーが変わった');

  const status = porcelainStatus(cwd);
  if (JSON.stringify(status.untracked) !== JSON.stringify(manifest.untracked)) {
    stale.push('untracked の集合が変わった');
  } else if (status.untracked.length > 0) {
    // 集合が同じでも中身が変わっていることがある（#570 で塞いだ失敗様式）。
    // 台帳にハッシュが無ければ「変わっていない」を証明できないので受理しない
    const before = snapshotUntrackedHashes(cwd, snap.snapshotId);
    if (!before) {
      throw new Error(
        `snapshot=${snap.snapshotId} の台帳に untracked の内容ハッシュがありません。` +
          'untracked が同名のまま書き換えられていないことを証明できないため受理できません',
      );
    }
    const root = git(['rev-parse', '--show-toplevel'], { cwd }).trim();
    const now = untrackedContentHashes(root, status.untracked);
    if (JSON.stringify(now) !== JSON.stringify(before)) {
      stale.push('untracked の内容が変わった');
    }
  }
  return { fresh: stale.length === 0, stale };
}

/** 台帳に残した untracked の内容ハッシュ（manifest ではなく index エントリ側にある）。 */
function snapshotUntrackedHashes(cwd, snapshotId) {
  const index = readIndex(reviewRoot(cwd));
  const entry = index.snapshots.find((e) => e.snapshotId === snapshotId);
  return entry?.untrackedHashes ?? null;
}

/**
 * 2つの snapshot の間の変更ファイルと、patch 由来のシグナル（ガード種変更・semantic doc 変更）を
 * 求める。`review-plan.js` が**系統ごとの再探索基準**（その系統が最後にレビューした snapshot →
 * 現在）を計算するために使う。
 *
 * **解決できない場合は throw する**（勝手に直前 snapshot へ縮めない）。dirty snapshot の commit は
 * `refs/agent-review/<id>` に守られており KEEP_REFS を超えると prune されるため、古い基準は
 * 取得不能になりうる。そこで「差分なし」を返すと、未レビューの累積差分を見落とす方向へ倒れる。
 *
 * **返すのは2点間の実差分**であって「範囲内で何が起きたか」ではない。中間 hop で入って消えた
 * 変更（net-zero）は現在の状態に無いのでレビュー対象にならず、ここでは現れない。
 * 「直前 hop の修正差分を必ず含む」という保証は**計画側**が持つ — `buildPlan` がこの結果を
 * `changedInFix` と、manifest の fail-closed シグナルと**和で**合成する。2つの層を1つに
 * まとめないこと（ここを和にすると net-zero で対象ゼロのまま全系統が最大コストへ固定され、
 * 計画側を差にすると見送った hop の変更が落ちる）。
 */
export function changedFilesBetween(cwd, fromSnapshotId, toSnapshotId) {
  const index = readIndex(reviewRoot(cwd));
  const find = (id) => {
    const entry = index.snapshots.find((e) => e.snapshotId === id);
    if (!entry)
      throw new Error(`snapshot=${id} が台帳にありません（既に整理された可能性があります）`);
    if (!entry.commit) throw new Error(`snapshot=${id} に commit が記録されていません`);
    // 台帳の部分破損（欠落 / null / 文字列）を黙って空扱いにしない。文字列だと
    // for-of が1文字ずつ回り、偽のパスを作る（敵対的 所見3 が実測）
    if (!Array.isArray(entry.untracked)) {
      throw new Error(`snapshot=${id} の untracked が配列ではありません（台帳の破損）`);
    }
    if (!entry.untrackedHashes || typeof entry.untrackedHashes !== 'object') {
      throw new Error(`snapshot=${id} の untrackedHashes がありません（台帳の破損）`);
    }
    // prune 済み・gc 済みの commit は差分を取れない。到達可能性を先に確かめる
    if (git(['cat-file', '-e', `${entry.commit}^{commit}`], { cwd, onFail: 'null' }) === null) {
      throw new Error(`snapshot=${id} の commit（${entry.commit}）が既に到達不能です`);
    }
    return entry;
  };
  const from = find(fromSnapshotId);
  const to = find(toSnapshotId);
  // **commit 差分だけでは足りない**: untracked と「検査できなかったパス」は commit に入らず、
  // 落とすと per-hop 側の fail-closed が累積経路でだけ外れる。台帳と各 hop の成果物から補う。
  // 具体的な事実を持つ順に積み、先に載ったパスは後段が足さない（1パス1エントリ。同じパスに
  // status の違う行が並ぶと読み手も `deriveSignals` も何が起きたか決められない）
  // 範囲の妥当性（seq の型・台帳の欠落）は**読む内容の有無に関わらず**先に確かめる。
  // 内容を読むときだけ検査すると、untracked が無い範囲で台帳の破損が素通りする
  const hops = hopsInRange(index, from, to);
  const tracked = classifiedNameStatus(cwd, from.commit, to.commit);
  const known = new Set(tracked.map((f) => f.path));
  const files = [...tracked, ...untrackedDelta(from, to, known)];
  files.push(...unreportedAt(cwd, to, new Set(files.map((f) => f.path))));
  // 判定器へ渡す patch には、**tracked 以外**のパスの内容も足す。untracked の内容は各 hop の
  // `previous-to-current.patch` にしか無く、足さないと `hasOpaque` が必ず真になって per-hop 側と
  // 受理集合が食い違う（無関係な untracked 1個で全系統が最大コストへ固定される）。
  //
  // 逆に足しすぎてもいけない。tracked は commit 差分が**正味の内容**を持っているので hop を
  // 足すと撤回済みの中間版まで走査され、`base-to-current.patch`（レビュアーへ渡す正本）に
  // 存在しない変更でトリガーが立つ。
  //
  // 判定基準は「**現在の内容が commit 差分に載っていないか**」＝ `to` で untracked かどうか。
  // 「`files` に何を載せるか」（1パス1エントリ）とは**別の問い**で、同じ条件で絞ると
  // `git rm --cached` して同じパスを書き直した場合に、ディスク上に実在する新内容が
  // エントリごと消えて誰も見ないまま収束する（敵対的 周回7 が実測。重複計上を消すために
  // 内容まで落としたのが原因）。範囲内で**最後に**内容が載った hop の分を採る
  const stillUntracked = new Set(to.untracked);
  const wanted = new Set(files.map((f) => f.path).filter((path) => stillUntracked.has(path)));
  const patch = diffPatch(cwd, from.commit, to.commit) + latestHopContent(cwd, hops, wanted);
  return {
    files,
    guardChange: detectGuardChange(patch, files),
    semanticDocChange: detectSemanticDocChange(patch, files),
  };
}

/**
 * patch を `diff --git` のファイル節へ切る。**境界は LF の直後だけ**に限定する —
 * JS の `^`（multiline）は孤立 CR・U+2028・U+2029 の直後にもマッチするため、本文に
 * `<CR>diff --git ` を含むファイルで境界を偽造でき、解析できない後半 chunk が無言で
 * 捨てられる（敵対的 F3 が実測）。見出しは手で組み立てず元のバイト列のまま扱う。
 */
function splitPatchChunks(patch) {
  if (!patch) return [];
  return patch
    .split('\ndiff --git ')
    .map((part, i) => (i === 0 ? part : `diff --git ${part}`))
    .filter((part) => part !== '');
}

/**
 * 範囲 (from, to] のうち、対象パスの内容が**最後に**載った hop の節。
 * 後の hop が前の hop を上書きするので、撤回された中間版は残らない。
 */
function latestHopContent(cwd, hops, wanted) {
  if (wanted.size === 0) return '';
  const byPath = new Map();
  for (const entry of hops) {
    const dir = join(reviewRoot(cwd), entry.snapshotId);
    const patch = readSnapshotFile(dir, entry.snapshotId, 'previous-to-current.patch');
    for (const chunk of splitPatchChunks(patch)) {
      for (const f of splitPatchByFile(chunk)) {
        if (wanted.has(f.path)) byPath.set(f.path, chunk);
      }
    }
  }
  return [...byPath.values()].join('');
}

/**
 * 範囲 (from, to] に入る台帳エントリ。**seq は呼び出し順に依存せずここで検証する** —
 * `Number.isInteger` だけでは 2^53 以上を通し、範囲比較と採番が食い違う（`isValidSeq` の由来）。
 */
function hopsInRange(index, from, to) {
  for (const [name, entry] of [
    ['from', from],
    ['to', to],
  ]) {
    if (!isValidSeq(entry.seq)) {
      throw new Error(
        `snapshot=${entry.snapshotId} の seq が不正です（${name}: ${JSON.stringify(entry.seq)}）。台帳が壊れている可能性があります`,
      );
    }
  }
  const hops = index.snapshots.filter((entry) => {
    if (!isValidSeq(entry.seq)) {
      throw new Error(`snapshot=${entry.snapshotId} の seq が不正です（台帳の破損）`);
    }
    return entry.seq > from.seq && entry.seq <= to.seq;
  });
  // 範囲には seq が1ずつ並ぶ。欠けていたらその hop の内容がエラーなく落ちる
  if (hops.length !== to.seq - from.seq) {
    throw new Error(
      `snapshot=${from.snapshotId}→${to.snapshotId} の範囲に台帳の欠落があります` +
        `（期待 ${to.seq - from.seq} 件 / 実際 ${hops.length} 件）。範囲内の変更を確認できません`,
    );
  }
  return hops;
}

/**
 * seq として受理する値。`Number.isInteger` では足りない — 2^53 以上は整数判定を通るのに
 * 採番（`nextSeq` の `max + 1`）が浮動小数で飽和して同じ値へ戻り、以後どの記録も追い越せない。
 */
export function isValidSeq(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * `to` の時点で**まだ検証できない**パス。patch には載らないので `hasOpaque` 経由で
 * fail-closed に倒れる。
 *
 * 範囲内の各 hop の分を足さない。中間 hop で `unreportedPaths` に載ったパスは、`to` までに
 * (a) 解消していれば commit 差分に現れる、(b) 消えていればレビュー対象が無い、のどちらかで、
 * 足すと**両端点に存在しないパスが status 'M' の phantom として恒久的に残り**、内容が読めない
 * ため `guardChange` を立て続ける（該当系統が1回走るまで解消手段が無い。敵対的 F2 が実測）。
 */
function unreportedAt(cwd, to, knownPaths) {
  const dir = join(reviewRoot(cwd), to.snapshotId);
  const manifest = readSnapshotArtifact(dir, to.snapshotId, 'manifest.json');
  // 「フィールドが無い」と「検査できなかったものが無かった」を同一視しない。
  // 空集合へ倒すと fail-closed が外れる
  if (!Array.isArray(manifest.unreportedPaths)) {
    throw new Error(
      `snapshot=${to.snapshotId} の manifest に unreportedPaths がありません（検査できなかったパスの有無を確認できません）`,
    );
  }
  return manifest.unreportedPaths
    .filter((path) => !knownPaths.has(path))
    .sort()
    .map((path) => ({
      path,
      status: 'M',
      additions: null,
      deletions: null,
      ...classifyFile(path),
    }));
}

/**
 * 2つの snapshot の間で変わった untracked ファイル。**内容は復元できない**（untracked は
 * commit に入らず、台帳が持つのはパスと内容ハッシュだけ）ので patch には載らず、
 * `detectGuardChange` / `detectSemanticDocChange` は `hasOpaque` 経由で fail-closed に倒れる。
 */
function untrackedDelta(from, to, trackedPaths) {
  const fromPaths = new Set(from.untracked ?? []);
  const toPaths = to.untracked ?? [];
  // 台帳由来の動的キーなので own property だけを見る（INVARIANTS #11）
  const hashOf = (entry, path) => {
    const hashes = entry.untrackedHashes;
    return hashes && Object.hasOwn(hashes, path) ? hashes[path] : undefined;
  };
  const out = [];
  // **commit 差分に載っているパスは足さない**（1パス1エントリ）。両側に効かせる —
  // 追加側を素通しすると `git rm --cached` が 'D' と 'U' の2エントリになり、新規ファイルが
  // 1つも増えていないのに `newFile` と `deletion` が同時に立つ（敵対的 F4 が実測）。
  // 削除側は untracked → commit 済みへ移ったパスで、存在しない削除を立てることになる
  for (const path of toPaths) {
    if (trackedPaths.has(path)) continue;
    const before = hashOf(from, path);
    // ハッシュが無い（旧形式の台帳・読めなかった）ものを「未変更」と断定しない。
    // createSnapshot の newUntracked と同じ規律で安全側＝変更扱いへ倒す
    if (fromPaths.has(path) && before !== undefined && before === hashOf(to, path)) continue;
    out.push({ path, status: 'U', ...classifyFile(path) });
  }
  for (const path of fromPaths) {
    if (to.untracked?.includes(path) || trackedPaths.has(path)) continue;
    out.push({ path, status: 'D', ...classifyFile(path) });
  }
  return out;
}

/** snapshot 成果物の読み出し。無ければ fail-loud（「読めないので検査を飛ばす」を作らない）。 */
function readSnapshotFile(dir, snapshotId, name) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    throw new Error(`snapshot=${snapshotId} の ${name} がありません（${dir}）`);
  }
  return readFileSync(file, 'utf-8');
}

function readSnapshotArtifact(dir, snapshotId, name) {
  try {
    return JSON.parse(readSnapshotFile(dir, snapshotId, name));
  } catch (err) {
    throw new Error(`snapshot=${snapshotId} の ${name} が壊れています（${err.message}）`, {
      cause: err,
    });
  }
}

/**
 * snapshotId を指定して snapshot を読む。台帳に無い・ディレクトリが消えている・成果物が
 * 読めない場合は **null ではなく throw** する。「読めないので検査を飛ばす」を許すと、
 * 古い snapshot を指定するだけで鮮度検証を迂回できる。
 *
 * `changedFiles` を含めるのは、`review-plan.js` が起動要求をその場で再計算するため。
 */
export function snapshotById(cwd, snapshotId) {
  const root = reviewRoot(cwd);
  const entry = readIndex(root).snapshots.find((e) => e.snapshotId === snapshotId);
  if (!entry) {
    throw new Error(`snapshot=${snapshotId} が台帳にありません（既に整理されたか、ID が誤り）`);
  }
  const dir = join(root, snapshotId);
  return {
    snapshotId,
    dir,
    manifest: readSnapshotArtifact(dir, snapshotId, 'manifest.json'),
    changedFiles: readSnapshotArtifact(dir, snapshotId, 'changed-files.json'),
  };
}

export function latestSnapshot(cwd = process.cwd()) {
  const index = readIndex(reviewRoot(cwd));
  const last = index.snapshots[index.snapshots.length - 1];
  if (!last) return null;
  return snapshotById(cwd, last.snapshotId);
}

function main() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : null;
  const { snapshotId, dir, manifest } = createSnapshot({ baseRef });
  // S4 で一度削除したが、敵対的レビューの実測（上流 main が PR tip を含む状態で fetch が成功すると
  // mergeBase===currentCommit になり、続く review:plan が Tier「なし」・系統0行・
  // 「計画が要求した起動: すべて記録済み」で収束する＝ガード変更 PR でも誰もレビューせず終わる）で
  // 復活させた。changedFiles===0 単独ではなく mergeBase===currentCommit も見て
  // 「HEAD が base に含まれている」ことを名指しする（テストの意図的な0件 fixture と区別するため）
  if (manifest.counts.changedFiles === 0 && manifest.mergeBase === manifest.currentCommit) {
    console.warn(
      'review-snapshot: ⚠ HEAD が base に含まれています。この状態で review:plan を回すと' +
        '系統0行で「すべて記録済み」になり、レビューされないまま収束します。' +
        '--base で正しい比較対象を指定してください',
    );
  }
  const baseFetch =
    manifest.baseFetch.length > 0
      ? manifest.baseFetch.map((f) => `${f.ref}:${f.status}`).join(',')
      : '(なし)';
  process.stdout.write(
    `snapshot=${snapshotId}\ndir=${dir}\nmergeBase=${manifest.mergeBase}\n` +
      `previous=${manifest.previousSnapshotId ?? '(なし・初回)'}\n` +
      `changedFiles=${manifest.counts.changedFiles}\ndirty=${manifest.dirty}\n` +
      `baseFetch=${baseFetch}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])review-snapshot\.js$/.test(process.argv[1])
) {
  main();
}
