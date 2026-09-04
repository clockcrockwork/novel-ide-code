// public 化前 strict secret scan（#345）。生成済み public tree を **明示的に対象指定**して
// gitleaks を走らせる（元 private repo の作業ツリーではなく、実際に公開するツリーを検査する。
// #345 レビュー指摘4）。POSIX shell 版（public-release-checklist.md §3）を Node 化して
// Windows からも npm script として実行可能にし、対象の取り違え（source/control repo を誤走査）を
// 構造的に防ぐ。依存フリー（node ビルトインのみ）。
//
// 使い方: node scripts/gh/run-strict-secret-scan.js --source <生成済み public tree> [--manifest <build 出力の manifest.json>]
// 前提: gitleaks が PATH にあること（不在なら fail-closed で exit 1）。検出 0 を期待。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { createHash, randomBytes } from 'node:crypto';
import { isPathInside } from '../policy/public-tree-policy.js';

// git blob 形式（`blob <byte長>\0<内容>`）の sha1。build-public-tree.js が manifest に埋め込む
// git 由来の blob sha と同一アルゴリズムで独立に再計算し、内容の一致を検証する
// （パス集合の一致だけでは「同名ファイルの中身だけ差し替わった対象」を検出できない。PR #458 Codex round4 指摘2）。
export function gitBlobSha1(buffer) {
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer]))
    .digest('hex');
}

// プロジェクト allowlist を一切持たない strict config。通常運用の `.gitleaks.toml` は
// フィクスチャ誤検出抑止で docs/ 等を allowlist するが、strict pass はそれを外して標準ルールのみで走らせる。
// 対象は生成済み public tree（node_modules/coverage 等を含まない）なので path allowlist は不要。
// これにより `.env.example` も走査対象に含まれる（#345 レビュー指摘4）。
const STRICT_CONFIG = '[extend]\nuseDefault = true\n';

// gitleaks の検出除外ファイル名。strict pass の「project allowlist を一切持たない」前提に
// 反するため、存在すれば fail-closed にする（PR-preflight round7 L-e）。
const GITLEAKSIGNORE_NAME = '.gitleaksignore';

// `gitleaks version` の出力形式検証（`v8.21.2` のような semver 風文字列であること）。
// 取得コマンド自体は成功（exit 0・非空 stdout）しても、壊れた/偽の gitleaks バイナリが
// バージョンと無関係な文字列（空文字近似・エラーメッセージの断片等）を返すケースを
// 「取得できた」と誤認しないため、形式検証を通らなければ後段の「不明」と同じ fail-closed
// 経路に合流させる（PR-preflight round6 F-3）。round7 L-f: 記録・出力するのは先頭行のうち
// この正規表現に**マッチした部分文字列のみ**（`\d+\.\d+\.\d+` 部分）とし、それ以外
// （末尾の ANSI エスケープ・CR 等）は捨てる（ログ・作業ログへの汚染混入を防ぐ）。
const GITLEAKS_VERSION_RE = /^v?\d+\.\d+\.\d+/;

// canary secret 生成用の英数字/数字チャートセット。crypto.randomBytes によるバイト値を
// mod 演算でチャートセットへ写像する（暗号強度の乱数性はそのまま維持。桁毎の bias は
// 検出可否の目的においては無視できる）。
const CANARY_ALNUM_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function randomAlnum(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CANARY_ALNUM_CHARS[bytes[i] % CANARY_ALNUM_CHARS.length];
  return out;
}
function randomDigits(length) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(bytes[i] % 10);
  return out;
}

// positive control で検出できることを要求する gitleaks ルール ID。github-pat 1系統だけでは
// 「gitleaks が完全に死んでいる」場合しか検出できず、特定ルール（正規表現）だけが壊れている
// 部分劣化を見逃す。系統の異なる3ルール（トークン形式の github-pat・slack-bot-token、
// ヘッダ形式の private-key）を横断させることで、検出ロジックの部分劣化も拾えるようにする
// （PR-preflight round6 F-3）。
const REQUIRED_CANARY_RULE_IDS = ['github-pat', 'slack-bot-token', 'private-key'];

// 対象が **git 作業ツリー内かどうか**を対象パス基準で判定する（cwd 非依存。#345 adversarial 🟠#3）。
// build-public-tree が生成する public tree は push 前は git 管理外なので、ここが true になるのは
// source/control repo（やその配下）を誤って指定した場合。cwd を基準にすると repo 外実行で
// ガードが無効化される弱点があったため、対象自身を見る方式に変える。
function targetIsInsideGitWorkTree(targetAbs) {
  const res = spawnSync('git', ['-C', targetAbs, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf-8',
  });
  // spawn 自体の失敗（git 不在等）は判定不能として fail-closed にする。旧実装は
  // `res.status === 0 && …` で非 0 終了を一律「git 管理外」に倒しており、壊れた/偽の git バイナリが
  // 任意の非 0 で終了すると誤って安全側チェックを無効化していた（PR #458 Codex round5 指摘）。
  if (res.error) {
    throw new Error(`git 実行に失敗しました（対象が git 管理外か判定できません。fail-closed）: ${res.error.message}`);
  }
  if (res.status === 0) return String(res.stdout).trim() === 'true';
  // 非 0 終了は「対象が git 管理外」という git 既知の正当なケース（exit 128・
  // `fatal: not a git repository ...`）でのみ false とみなす。生成済み public tree は
  // push 前は非 git のためこの経路が通常運用（実測で確認済み）。それ以外の非 0 終了
  // （破損・想定外の git 挙動）は判定不能として fail-closed にする。
  if (res.status === 128 && /not a git repository/.test(String(res.stderr))) return false;
  throw new Error(
    `git の実行結果から対象が git 管理外か判定できません（fail-closed。exit=${res.status}）: ${String(res.stderr).trim().slice(0, 200)}`,
  );
}

// dirAbs 配下を posix 相対パスで再帰列挙する（manifest との完全一致検証用。依存フリー）。
// symlink/FIFO/socket 等の非通常エントリは `files` に含めず `irregular` へ分ける——
// 黙って無視すると、build-public-tree.js が禁止している symlink 等が対象へ混入していても
// manifest 完全一致チェックをすり抜けてしまう（PR #458 Codex round3 指摘2）。
function listEntriesRecursive(dirAbs, relPrefix = '') {
  const files = [];
  const irregular = [];
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const abs = join(dirAbs, entry.name);
    if (entry.isDirectory()) {
      const sub = listEntriesRecursive(abs, rel);
      files.push(...sub.files);
      irregular.push(...sub.irregular);
    } else if (entry.isFile()) {
      files.push(rel);
    } else {
      irregular.push(rel); // symlink / FIFO / socket / block device / character device 等
    }
  }
  return { files, irregular };
}

export function runStrictSecretScan({ source, manifestPath, spawn = spawnSync } = {}) {
  if (!source) throw new Error('--source（走査対象の生成済み public tree）が必要です');
  // manifestPath === '' は「未指定のつもりが空文字を渡してしまった」呼び出し側のミス
  // （シェル変数展開漏れ等）を示す。`undefined`（意図的な未指定）とは区別し fail-closed にする
  // （PR #458 Codex round5 指摘。CLI 層の parseArgs にも同種のガードあり）。
  if (manifestPath === '') throw new Error('manifestPath が空文字です（束縛を無効化したい場合は manifestPath 自体を渡さない）');
  const target = resolve(source);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new Error(`走査対象がディレクトリとして存在しません: ${target}`);
  }
  // 空ディレクトリを「検出 0」で合格させない（stale/取り違えの検出。#345 adversarial 🟠#3-a）
  if (readdirSync(target).length === 0) {
    throw new Error(`走査対象が空です: ${target}（生成済み public tree を指定してください）`);
  }
  // source/control repo そのもの（や配下）を誤って走査しないこと。生成済み public tree は
  // push 前は git 管理外である前提（build-public-tree.js が repo 外に作る。#345 C8）
  if (targetIsInsideGitWorkTree(target)) {
    throw new Error(`走査対象が git 作業ツリー内です: ${target}（source/control repo の誤指定の疑い。push 前の生成済み public tree を指定してください）`);
  }
  // .gitleaksignore は gitleaks の検出除外機構であり、STRICT_CONFIG が
  // 「プロジェクト allowlist を一切持たない」という strict pass の定義そのものに反する
  // （`.gitleaksignore` は既定で `.`＝gitleaks 実行時の cwd から解決されるが、`--source` の
  // 対象ツリー配下に置かれても gitleaks が拾いうるため両方を検査する）。存在すれば fail-closed
  // で停止する（PR-preflight round7 L-e）。
  for (const dir of new Set([process.cwd(), target])) {
    const ignorePath = join(dir, GITLEAKSIGNORE_NAME);
    if (existsSync(ignorePath)) {
      throw new Error(
        `.gitleaksignore が見つかりました（${ignorePath}）。strict pass はプロジェクト allowlist を一切持たない前提のため .gitleaksignore による検出除外も許可しません。fail-closed で停止します。該当ファイルを削除するか隔離してから再実行してください`,
      );
    }
  }
  // manifest 指定時は build 出力とスキャン対象を束縛する（別ツリー/stale の取り違え防止。#345 adversarial 🟠#3-b）。
  // included が配列でない/空の manifest（`--manifest package.json` 等の指定ミス）は「空配列扱いで素通り」
  // させず fail-closed にする（束縛ゲートを無効化させない。PR #458 Codex 指摘4）。
  if (manifestPath) {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf-8'));
    if (!Array.isArray(manifest.included) || manifest.included.length === 0) {
      throw new Error(
        `manifest の included が非空配列ではありません（build-public-tree.js が出力した manifest.json を指定してください）: ${resolve(manifestPath)}`,
      );
    }
    // symlink/FIFO 等の非通常エントリの検出を、実ファイル読み込み（statSync/readFileSync）より
    // **前**に行う。旧順序では内容ハッシュ検証（readFileSync）がこのチェックより先に走り、
    // included に symlink パスが含まれていると（`statSync` はリンクを追従するため `bad` フィルタも
    // 通過してしまう）target 外の任意ファイルを読み込んでしまう経路があった
    // （最終的には後段の irregular チェックで fail するが、読み込み自体が起きてしまう。
    // PR #458 Codex round5 指摘。#345 敵対的再レビュー round3 指摘2 の対策を hash 検証より前に前倒し）。
    const { files: actualFiles, irregular } = listEntriesRecursive(target);
    if (irregular.length > 0) {
      throw new Error(
        `走査対象に非通常ファイル（symlink/特殊ファイル）があります（${irregular.length} 件。build 側の symlink 禁止と矛盾）: ${irregular.slice(0, 5).join(', ')}${irregular.length > 5 ? ' …' : ''}`,
      );
    }
    // included の各要素は「対象内に実在する通常ファイルの相対パス」でなければならない。空文字・`.`・`..`・
    // ディレクトリ等のジャンク要素が字面「非空配列」だけで束縛を無効化するのを防ぐ（fail-closed。PR #458 敵対的再レビュー）。
    // セグメント分割は '/' と '\' の両方を区切りとして扱う——manifest.included の値は git 由来で
    // 常に '/' 区切りのはずだが、Windows 由来の細工された値（`..\outside.txt` 等）が `.split('/')` の
    // セグメントチェックをすり抜けて target 外の実ファイルを指す経路を塞ぐ（PR #458 Codex round3 指摘1）。
    // resolve() 後の isPathInside による実体パス検証も併用する多重防御。
    const bad = manifest.included.filter((p) => {
      if (typeof p !== 'string' || p === '') return true;
      const segments = p.split(/[/\\]+/).filter((s) => s !== '');
      if (segments.length === 0 || segments.includes('..')) return true;
      const abs = resolve(target, p);
      if (!isPathInside(target, abs)) return true;
      return !existsSync(abs) || !statSync(abs).isFile();
    });
    if (bad.length > 0) {
      throw new Error(
        `manifest の included が走査対象内の実ファイルと一致しません（${bad.length} 件。build 出力と対象が不一致・不正要素）: ${bad.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}${bad.length > 5 ? ' …' : ''}`,
      );
    }
    // パス集合の一致だけでは内容の差し替えを検出できない（同名ファイルが private prose 等に
    // 置き換わっていても、パスが揃っていて gitleaks が反応しなければ通過してしまう）。build 側が
    // 埋め込んだ git blob sha1 と独立再計算した値を突き合わせる（PR #458 Codex round4 指摘2）。
    // includedShas は manifest JSON（外部入力）由来の動的キーを持つため、プロトタイプ汚染対策で
    // Object.create(null) 経由に正規化してからアクセスする（INVARIANTS #11）。
    if (
      typeof manifest.includedShas !== 'object' ||
      manifest.includedShas === null ||
      Array.isArray(manifest.includedShas)
    ) {
      throw new Error(
        `manifest の includedShas が不正です（build-public-tree.js が出力した manifest.json を指定してください）: ${resolve(manifestPath)}`,
      );
    }
    const includedShas = Object.assign(Object.create(null), manifest.includedShas);
    const hashMismatch = manifest.included.filter((p) => {
      const expected = includedShas[p];
      if (typeof expected !== 'string' || expected === '') return true;
      return gitBlobSha1(readFileSync(resolve(target, p))) !== expected;
    });
    if (hashMismatch.length > 0) {
      throw new Error(
        `走査対象のファイル内容が manifest の記録と一致しません（${hashMismatch.length} 件。生成後の改変/取り違えの疑い）: ${hashMismatch.slice(0, 5).join(', ')}${hashMismatch.length > 5 ? ' …' : ''}`,
      );
    }
    // included の実在確認だけでは「対象内に manifest 未記載の余剰ファイルがある」取り違えを検出できない
    // （stale な生成先・別ディレクトリでも included が全部揃っていれば通ってしまう）。対象の通常ファイル
    // 一覧が manifest と完全一致することも要求する（PR #458 敵対的再レビュー round2 指摘1）。
    const manifestSet = new Set(manifest.included);
    const extra = actualFiles.filter((f) => !manifestSet.has(f));
    if (extra.length > 0) {
      throw new Error(
        `走査対象に manifest 未記載のファイルがあります（${extra.length} 件。取り違え/生成後の改変の疑い）: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}`,
      );
    }
  }

  // gitleaks のバージョンを scan 実行前に出す（S9: AWS サンプル値等の非検出が gitleaks 既定
  // allowlist のバージョン依存であることを追跡可能にする。取得コマンドがハングした場合に備え
  // timeout 10s を付ける（ラウンド3敵対的 A-12）。ログはここで直接出す（detect 呼び出しの**前**。
  // detect が ENOENT/シグナル/検出ありで失敗して例外を投げても、version 行は既に出力済みで残る＝
  // 失敗経路でも欠落しない。ラウンド3仕様 S16）。取得失敗・timeout で「不明」になった場合は
  // **fail-closed（exit 1）にする**——version が分からないと「AWS サンプル値等の非検出が上流
  // allowlist 依存で意図的か、gitleaks 自体が壊れて何も検出できていないか」を区別する唯一の
  // 手がかりを失うため、検出0の結果を信頼できない（ラウンド4敵対的3。旧版は「不明」のまま
  // scan を続行していた）。
  let gitleaksVersion = '不明';
  let versionFetchError;
  try {
    const versionRes = spawn('gitleaks', ['version'], { encoding: 'utf-8', timeout: 10000 });
    if (versionRes.error) {
      versionFetchError = versionRes.error;
    } else if (versionRes.status === 0 && versionRes.stdout) {
      // 先頭行のみを対象にする（複数行 stdout の2行目以降のノイズを無視。round7 L-f）。
      const firstLine = String(versionRes.stdout).split(/\r?\n/, 1)[0].trim();
      // semver 風（`v?数字.数字.数字` 始まり）でなければ「不明」と同じ fail-closed 経路に倒す
      // （取得コマンドは成功したが返り値がバージョン文字列として不正＝信頼できない。round6 F-3）。
      // 記録するのは正規表現に**マッチした部分文字列のみ**（末尾の ANSI エスケープ・CR 等は
      // 捨てる。round7 L-f）。
      const match = GITLEAKS_VERSION_RE.exec(firstLine);
      gitleaksVersion = match ? match[0] : '不明';
    }
  } catch (err) {
    versionFetchError = err;
  }
  process.stderr.write(`gitleaks version: ${gitleaksVersion}\n`);
  if (gitleaksVersion === '不明') {
    // ENOENT（gitleaks コマンド自体が存在しない）は detect 側の同種エラーと同じ分かりやすい文言にする。
    // それ以外（timeout・非0終了等）は汎用の fail-closed 文言。
    if (versionFetchError && versionFetchError.code === 'ENOENT') {
      throw new Error('gitleaks コマンドが見つかりません。事前にインストールしてください');
    }
    throw new Error(
      'gitleaks version が取得できません（timeout・不明な終了状態等）。検出結果を信頼できないため fail-closed で停止します。gitleaks を再インストールしてから再実行してください',
    );
  }

  const tmp = mkdtempSync(join(tmpdir(), 'gitleaks-strict-'));
  const cfg = join(tmp, 'gitleaks-strict.toml');
  try {
    writeFileSync(cfg, STRICT_CONFIG);

    // positive control: 「検出 0」は (a) 本当に leaks が無い (b) gitleaks 自体が劣化していて
    // 何も検出できない、の両方で起こる。stub/壊れたバイナリが常に exit 0 を返すケースを実測で
    // 確認済み（ラウンド4敵対的3）。実行時に生成した canary secret（静的リテラルで書くと本
    // ファイル自体が strict scan の対象になったとき誤検出するため実行時連結する）を同じ strict
    // config で検出できることを、本番対象の scan より**前**に確認する。**github-pat 単体だけでは
    // 「gitleaks が完全に死んでいる」場合しか検出できず、他ルールの正規表現だけが壊れる部分劣化を
    // 見逃す**ため、系統の異なる3ルール（github-pat・slack-bot-token・private-key）を canary
    // ディレクトリへ同時に置き、`--report-format json` の検出結果（RuleID）で3ルールすべてが
    // 検出されたことを要求する（PR-preflight round6 F-3）。**低エントロピーな文字列（同一文字の
    // 繰返し等）は gitleaks の誤検出抑止フィルタで無検出になり positive control が常に fail する**
    // ため（実測で確認済み: 'ghp_'+'a'.repeat(36) は無検出）、crypto.randomBytes で高エントロピー
    // な値を生成する。canary 用の一時ディレクトリ名は mkdtempSync の6文字ランダムサフィックス
    // （PRNG の暗号強度は保証されない）に加え、crypto.randomBytes 由来の追加サフィックスを
    // prefix に含めて予測不能性を上げる。
    const canaryDirPrefix = `gitleaks-canary-${randomBytes(8).toString('hex')}-`;
    const canaryDir = mkdtempSync(join(tmpdir(), canaryDirPrefix));
    try {
      writeFileSync(join(canaryDir, 'github-pat.txt'), `ghp_${randomAlnum(36)}`);
      writeFileSync(
        join(canaryDir, 'slack-bot-token.txt'),
        `xoxb-${randomDigits(12)}-${randomDigits(12)}-${randomAlnum(24)}`,
      );
      writeFileSync(
        join(canaryDir, 'private-key.txt'),
        `-----BEGIN RSA PRIVATE KEY-----\n${randomAlnum(64)}\n-----END RSA PRIVATE KEY-----\n`,
      );
      const canaryReportPath = join(canaryDir, 'canary-report.json');
      // timeout 30s: canary は3ファイルのみを走査する小さな呼び出しのため、本番 detect（10分）より
      // 短い上限で十分。超過は「検出結果を信頼できない」ため version 取得の timeout（10s）と同じ
      // fail-closed の扱いにする（PR-preflight round6 L-1）。
      const canaryRes = spawn(
        'gitleaks',
        [
          'detect', '--no-git', '--no-banner', '--redact', '-c', cfg,
          '--source', canaryDir, '--report-format', 'json', '--report-path', canaryReportPath,
        ],
        { stdio: 'ignore', timeout: 30000 },
      );
      if (canaryRes.error) {
        if (canaryRes.error.code === 'ENOENT') {
          throw new Error('gitleaks コマンドが見つかりません。事前にインストールしてください');
        }
        if (canaryRes.error.code === 'ETIMEDOUT') {
          throw new Error(
            'positive control（canary 検出）が timeout 30秒を超えました。検出結果を信頼できないため fail-closed で停止します。gitleaks を再インストールしてから再実行してください',
          );
        }
        throw canaryRes.error;
      }
      if (canaryRes.signal) {
        throw new Error(`positive control（canary 検出）がシグナル ${canaryRes.signal} で終了しました。fail-closed で停止します`);
      }
      let detectedRuleIds;
      try {
        const report = JSON.parse(readFileSync(canaryReportPath, 'utf-8'));
        detectedRuleIds = new Set(Array.isArray(report) ? report.map((f) => f.RuleID) : []);
      } catch (err) {
        throw new Error(
          `positive control のレポート（${canaryReportPath}）を読み込めません。gitleaks が劣化している疑いがあるため fail-closed で停止します: ${err.message}`,
          { cause: err },
        );
      }
      const missingRuleIds = REQUIRED_CANARY_RULE_IDS.filter((id) => !detectedRuleIds.has(id));
      // round7 N-2: JSON report のルール判定だけでは、「report は正しく書くが exit code が
      // 常に 0（成功扱い）」という gitleaks（本番の scan 判定は exit code のみを見る）に対して
      // positive control が素通りしてしまう（本番側は fail-open のまま）。round4 で入れていた
      // exit code 判定（canaryRes.status === 0 は失敗）を復活し、「exit code 非 0」∧「3 ルール
      // すべて report に出現」の両方を要求する。
      const exitCodeIndicatesDetection = canaryRes.status !== 0;
      if (missingRuleIds.length > 0 || !exitCodeIndicatesDetection) {
        const exitCodeReason = exitCodeIndicatesDetection
          ? ''
          : 'report 上は検出済みでも gitleaks の exit code が 0 でした（検出ありなら非0を期待。round4 の exit code 判定を復活。round7 N-2）。';
        throw new Error(
          `positive control 失敗（検出ルール: ${[...detectedRuleIds].join(', ') || 'なし'}）。${exitCodeReason}` +
            `gitleaks が canary secret（実行時生成のダミートークン。要求ルール: ${REQUIRED_CANARY_RULE_IDS.join(', ')}）の一部を検出できませんでした。` +
            'gitleaks が劣化している疑いがあるため fail-closed で停止します（本番対象の検出結果は信頼できません）',
        );
      }
    } finally {
      rmSync(canaryDir, { recursive: true, force: true });
    }

    // timeout 10分: 大きな public tree の走査に時間がかかりうるため canary（30s）より長く取る。
    // 超過は「検出結果を信頼できない」ため fail-closed（PR-preflight round6 L-1）。
    const res = spawn(
      'gitleaks',
      ['detect', '--no-git', '--no-banner', '--redact', '-c', cfg, '--source', target],
      { stdio: 'inherit', timeout: 600000 },
    );
    if (res.error) {
      if (res.error.code === 'ENOENT') {
        throw new Error('gitleaks コマンドが見つかりません。事前にインストールしてください');
      }
      if (res.error.code === 'ETIMEDOUT') {
        throw new Error(
          'gitleaks の検出が timeout 10分を超えました。検出結果を信頼できないため fail-closed で停止します。gitleaks を再インストールしてから再実行してください',
        );
      }
      throw res.error;
    }
    if (res.signal) throw new Error(`gitleaks がシグナル ${res.signal} で終了しました`);
    if (res.status !== 0) {
      throw new Error(`gitleaks が検出あり/エラーで終了しました（exit=${res.status}）。検出内容を確認してください`);
    }
    return { ok: true, target, gitleaksVersion };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { source: undefined, manifest: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') {
      args.source = argv[++i];
      if (!args.source) throw new Error('--source の値が空/欠落しています');
    } else if (argv[i] === '--manifest') {
      // 値が空/欠落（次の引数が無い・空文字・別オプションの文字列）だと `args.manifest` が
      // falsy になり、後段の `if (manifestPath)` が false で manifest 束縛ゲート自体が
      // 無効化されてしまう。シェル変数展開漏れ（`--manifest "$MANIFEST"` で MANIFEST が空）を
      // silent スキップさせず、parse 時点で fail させる（PR #458 Codex round5 指摘）。
      args.manifest = argv[++i];
      if (!args.manifest) throw new Error('--manifest の値が空/欠落しています（束縛を無効化したい場合は --manifest 自体を渡さない）');
    } else {
      throw new Error(`不明な引数: ${argv[i]}`);
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`run-strict-secret-scan: ${err.message}`);
    console.error('使い方: node scripts/gh/run-strict-secret-scan.js --source <生成済み public tree> [--manifest <manifest.json>]');
    process.exit(1);
  }
  try {
    const { target } = runStrictSecretScan({ source: args.source, manifestPath: args.manifest });
    console.error(`strict secret scan: 検出 0（対象 ${target}）`);
  } catch (err) {
    console.error(`run-strict-secret-scan: ${err.message}`);
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  /(^|[/\\])run-strict-secret-scan\.js$/.test(process.argv[1])
) {
  main();
}
