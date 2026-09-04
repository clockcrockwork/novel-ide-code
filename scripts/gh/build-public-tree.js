// public code repo 用の sanitized tree 生成（#345）。
// 現在の作業ツリーからコピーせず **HEAD コミットの blob** を読む（unstaged/staged 変更・実行中の
// ファイル変化・stale 出力に汚染されない。#345 レビュー指摘5）。denylist 方式で control-only 3
// ディレクトリのみ除外し、secret 風 tracked / symlink / submodule / 非 regular file は
// **silent 除外せず fail**（fail-closed。同レビュー指摘3/5）。source repo は read-only、書き込みは
// 出力先のみ。public repo 作成・push は行わない（オーナー手動実行）。
//
// 使い方: node scripts/gh/build-public-tree.js --out <空または未作成の出力先> [--source <repo>]
// 依存フリー（node ビルトインのみ）。denylist / secret 判定の正本は scripts/policy/public-tree-policy.js。
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  readdirSync,
  existsSync,
  statSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { classifyPublicTreePath, isPathInside } from '../policy/public-tree-policy.js';

// denylist 方式では secret でも control-only でもない生成物（Vite の依存メタデータ等）が
// tracked だと素通りで public tree に入る。既知の生成物プレフィックスは build 後に警告する
// （恒久対策は tracked 解除の別 PR。runbook §3 前提ゲート。#345 operability F4 / adversarial A2）。
const GENERATED_ARTIFACT_PREFIXES = ['.vite/'];

const MAX_BUFFER = 256 * 1024 * 1024;

// git 実行ランナー。テストから差し替え可能にするため引数で受ける（fail-closed 経路の検証用）。
export function makeGitRunner(cwd) {
  return (args, { buffer = false } = {}) =>
    execFileSync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      ...(buffer ? {} : { encoding: 'utf-8' }),
    });
}

// symlink 経由の source 配下判定バイパスを防ぐため、lexical な resolve() ではなく実体パスで判定する
// （`--out`/`--manifest` の親が source 内を指す symlink だと resolve() は素通りする。PR #458 敵対的再レビュー round2 指摘4）。
// out/manifest は生成前で存在しないことが多いため、存在する最も近い祖先の realpath を使う——
// 非存在パスの途中に symlink は作れないので、祖先の実体位置が分かれば以降の書き込み先も確定する。
function realpathOfNearestExisting(absPath) {
  let cur = absPath;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // ルートに到達
    cur = parent;
  }
  return realpathSync(cur);
}

// `git ls-tree -r -z HEAD` の 1 レコードを分解する。形式: `<mode> SP <type> SP <sha> TAB <path>`。
// -z によりレコードは NUL 区切り・path はクォートされない（空白/日本語/改行を安全に扱う。#345 C3）。
function parseTreeEntry(record) {
  const tab = record.indexOf('\t');
  if (tab === -1) throw new Error(`ls-tree 出力の解析に失敗: ${JSON.stringify(record.slice(0, 60))}`);
  const [mode, type, sha] = record.slice(0, tab).split(' ');
  const path = record.slice(tab + 1);
  return { mode, type, sha, path };
}

// public tree を生成し、判定結果のサマリを返す。fail は例外送出（不完全な出力を残さない）。
export function buildPublicTree({ sourceRepo = process.cwd(), outDir, manifestPath, runGit } = {}) {
  if (!outDir) throw new Error('出力先（outDir / --out）が必要です');
  const sourceAbs = resolve(sourceRepo);
  const git = runGit ?? makeGitRunner(sourceAbs);

  // source が git リポジトリのルートであること（fail-closed。git 不在・非 git は execFileSync が throw）
  const topLevel = resolve(git(['rev-parse', '--show-toplevel']).trim());
  if (topLevel !== sourceAbs) {
    throw new Error(`--source はリポジトリのルートを指してください（toplevel=${topLevel}）`);
  }

  // dirty worktree は sanitized snapshot の前提を崩すため fail（#345 レビュー指摘5）
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) throw new Error('作業ツリーに未コミットの変更があります。clean な状態で実行してください');

  const headBefore = git(['rev-parse', 'HEAD']).trim();

  // tracked ファイル一覧（HEAD コミットのツリー）。-r は blob/gitlink のみ返す（tree は展開）
  const raw = git(['ls-tree', '-r', '-z', 'HEAD']);
  const records = raw.split('\0').filter(Boolean);
  if (records.length === 0) {
    throw new Error('HEAD に tracked ファイルがありません（空リポジトリ/clone 失敗の疑い）');
  }

  const include = [];
  const excluded = [];
  const failures = [];
  for (const rec of records) {
    const { mode, type, sha, path } = parseTreeEntry(rec);
    if (mode === '120000') {
      failures.push(`symlink は public tree に出せません（fail-closed）: ${path}`);
      continue;
    }
    if (mode === '160000' || type === 'commit') {
      failures.push(`submodule/gitlink は public tree に出せません: ${path}`);
      continue;
    }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      failures.push(`未対応のファイル種別（mode=${mode} type=${type}）: ${path}`);
      continue;
    }
    // パス判定（`\`・制御文字・非 ASCII・secret 風・control-only・docs/agent-memory/ の想定外配置）は
    // すべて scripts/policy/public-tree-policy.js の classifyPublicTreePath に単一正本化されている
    // （ラウンド3減算 S-1/S-8。本ファイル側に判定ロジック・2周目ループを持たない）。
    const kind = classifyPublicTreePath(path);
    if (kind === 'invalid-path') {
      failures.push(`パスに \\・制御文字・非 ASCII 文字のいずれかを含むファイルは public tree に出せません（fail-closed。区切り文字判定のすり抜け・同形グリフの疑い。ラウンド4敵対的2）: ${path}`);
      continue;
    }
    if (kind === 'forbidden-secret') {
      failures.push(`secret 風ファイルが tracked されています（gitignore 漏れの疑い。除外ではなく修正が必要）: ${path}`);
      continue;
    }
    if (kind === 'agent-memory-misplaced') {
      failures.push(`docs/agent-memory/ 配下の想定外の場所にある記憶レコードのため public tree に含められません（fail-closed。docs/agent-memory/ 配下は .md 以外を置かない）: ${path}`);
      continue;
    }
    if (kind === 'control-only') {
      excluded.push(path);
      continue;
    }
    include.push({ mode, sha, path });
  }

  // secret/symlink/submodule/未対応種別が 1 件でもあれば出力せず fail（silent 除外禁止）
  if (failures.length > 0) {
    throw new Error(`public tree 生成を中止しました（${failures.length} 件）:\n- ${failures.join('\n- ')}`);
  }
  if (include.length === 0) {
    throw new Error('public tree に含めるファイルが 0 件です（除外条件が広すぎる疑い）');
  }

  // 出力先は source repo 配下でないこと（source 汚染防止。#345 C8）。lexical 判定に加え、
  // symlink 経由で source 内へ実際には書き込まれる経路を realpath で検出する（round2 指摘4）
  const sourceReal = realpathSync(sourceAbs);
  const outAbs = resolve(outDir);
  if (isPathInside(sourceAbs, outAbs) || isPathInside(sourceReal, realpathOfNearestExisting(outAbs))) {
    throw new Error(`出力先を source repo の外に指定してください: ${outAbs}`);
  }

  // 出力先は未作成または空であること（stale file 混入防止。#345 D7）
  if (existsSync(outAbs)) {
    if (!statSync(outAbs).isDirectory() || readdirSync(outAbs).length > 0) {
      throw new Error(`出力先は存在しないか空である必要があります: ${outAbs}`);
    }
  }

  // manifest パスは public tree の外・**source repo（control repo）の外**・親ディレクトリ準備可能で
  // あることを tree 確定（rename）前に検証する。さもないと不正な manifest パス（tree 内・source 内・
  // 作成不能な親）で public tree が残ったり、manifest（excluded 一覧＝内部パス情報を含む）が control repo
  // を汚染したりする（PR #458 Codex 指摘2・round2 指摘2。symlink 経由の source 内書込は realpath で検出）。
  const manifestAbs = manifestPath ? resolve(manifestPath) : `${outAbs}.manifest.json`;
  if (isPathInside(outAbs, manifestAbs)) {
    throw new Error(`manifest は public tree の外に出力してください: ${manifestAbs}`);
  }
  if (isPathInside(sourceAbs, manifestAbs) || isPathInside(sourceReal, realpathOfNearestExisting(manifestAbs))) {
    throw new Error(`manifest は source repo（control repo）の外に出力してください: ${manifestAbs}`);
  }
  // out が既存の空ディレクトリの場合、manifest が symlink 経由でその実体内を指すと（例:
  // `--out /tmp/public --manifest /tmp/public-link/manifest.json` で `/tmp/public-link -> /tmp/public`）、
  // 字面だけの isPathInside(outAbs, manifestAbs) は通過し、書き込まれた manifest は直後の
  // `rmSync(outAbs)` で握りつぶされコマンドは成功表示のまま manifest が存在しなくなる。out が未作成なら
  // この経路は成立しない（親ディレクトリが実在せず書き込み自体が失敗する）ため、既存の場合のみ検証する
  // （PR #458 Codex round4 指摘3）。
  if (existsSync(outAbs) && isPathInside(realpathSync(outAbs), realpathOfNearestExisting(manifestAbs))) {
    throw new Error(`manifest は public tree の外に出力してください（symlink 経由の実体パスで検出）: ${manifestAbs}`);
  }
  mkdirSync(dirname(manifestAbs), { recursive: true });

  const includedPaths = include.map((e) => e.path);
  // denylist を素通りした既知生成物（.vite/ 等）を警告（runbook 目視ゲートの補助。fail はしない）
  const generatedLeaks = includedPaths.filter((p) =>
    GENERATED_ARTIFACT_PREFIXES.some((pre) => p.startsWith(pre)),
  );
  // includedShas: 各ファイルの git blob sha1（既に git から取得済みの値を再利用。追加計算不要）。
  // strict scan 側がファイル内容を manifest と束縛するために使う（パス集合の一致だけでは「同名ファイルの
  // 中身だけ差し替わった対象」を検出できない。PR #458 Codex round4 指摘2）。動的キー（ファイルパス）を
  // 持つオブジェクトなのでプロトタイプ汚染対策で Object.create(null) 経由にする（INVARIANTS #11）。
  const includedShas = Object.assign(Object.create(null), Object.fromEntries(include.map((e) => [e.path, e.sha])));
  // manifest = included / excluded の全一覧（denylist 方式の残余リスクを人間が目視レビューできる唯一の手段）
  const manifestJson = JSON.stringify(
    { headSha: headBefore, includedCount: include.length, excludedCount: excluded.length, included: includedPaths, includedShas, excluded, generatedLeaks },
    null,
    2,
  );

  // temp に生成 → manifest 書き込み → 成功後に rename（失敗時は不完全な出力を残さない）。EXDEV 回避のため
  // 出力先の親に作る。manifest 書き込みは rename の**前**に行い、書込失敗（EISDIR/EACCES/ENOSPC 等）でも
  // public tree を残さない（PR #458 Codex 指摘2 + 敵対的再レビュー: mkdirSync の冪等では既存だが書込不可な親を検出できない）。
  const parent = dirname(outAbs);
  mkdirSync(parent, { recursive: true });
  const tmp = mkdtempSync(join(parent, '.public-tree-tmp-'));
  try {
    for (const { mode, sha, path } of include) {
      const dest = resolve(tmp, path);
      if (!isPathInside(tmp, dest)) {
        throw new Error(`出力先ルート外への書き込みを拒否（path traversal）: ${path}`);
      }
      const content = git(['cat-file', 'blob', sha], { buffer: true });
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
      chmodSync(dest, mode === '100755' ? 0o755 : 0o644);
    }

    // 生成中に HEAD が動いていないこと（外部からの並行変更検出。#345 D8）
    const headAfter = git(['rev-parse', 'HEAD']).trim();
    if (headAfter !== headBefore) {
      throw new Error(`生成中に HEAD が変化しました（${headBefore} → ${headAfter}）`);
    }

    writeFileSync(manifestAbs, manifestJson); // rename 前。失敗すれば catch で tmp を消し tree を残さない
    if (existsSync(outAbs)) rmSync(outAbs, { recursive: true, force: true });
    renameSync(tmp, outAbs);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  return {
    headSha: headBefore,
    total: records.length,
    includedCount: include.length,
    excludedCount: excluded.length,
    included: includedPaths,
    excluded,
    generatedLeaks,
    manifestPath: manifestAbs,
  };
}

function parseArgs(argv) {
  const args = { source: process.cwd(), out: undefined, manifest: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--manifest') args.manifest = argv[++i];
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`build-public-tree: ${err.message}`);
    console.error('使い方: node scripts/gh/build-public-tree.js --out <空/未作成の出力先> [--source <repo>]');
    process.exit(1);
  }
  try {
    const r = buildPublicTree({ sourceRepo: args.source, outDir: args.out, manifestPath: args.manifest });
    console.error(
      `public tree 生成: HEAD=${r.headSha.slice(0, 12)} 総数=${r.total} 含=${r.includedCount} 除外=${r.excludedCount}`,
    );
    console.error(`除外（control-only）: ${r.excluded.length ? r.excluded.length + ' 件' : 'なし'}`);
    console.error(`manifest（included/excluded 全一覧・目視レビュー用）: ${r.manifestPath}`);
    if (r.generatedLeaks.length > 0) {
      console.error(
        `\n⚠️  生成物が public tree に含まれています（${r.generatedLeaks.length} 件）。tracked 解除の別 PR（runbook §3）を先に済ませてください:`,
      );
      for (const p of r.generatedLeaks) console.error(`    - ${p}`);
    }
  } catch (err) {
    console.error(`build-public-tree: ${err.message}`);
    process.exit(1);
  }
}

// 自己起動ガード（ncc バンドル対策で basename も判定。他スクリプトと同型）
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])build-public-tree\.js$/.test(process.argv[1])
) {
  main();
}
