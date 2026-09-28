import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Claude Code PreToolUse hook: PR 作成・本文更新（mcp__github__create_pull_request /
// update_pull_request）の前に、PR 本文を check-artifacts へ通す。
// CI の artifacts-gate で赤にしてから直すのではなく、PR を作る前にローカルで止める。
// 検査できない状況（stdin 不正・git 失敗等）は fail-open とする（CI 側が最終防衛線）。
// 既知の限界: update_pull_request で「現在のブランチと別の PR」の本文を編集する場合、
// 手元 HEAD の diff で分類するため誤判定しうる（その場合も CI が正）。
// 登録: .claude/settings.json の hooks.PreToolUse

function failOpen() {
  process.exit(0);
}

// 手動実行（stdin が TTY）では readFileSync(0) が入力待ちでハングするため即 fail-open する
if (process.stdin.isTTY) failOpen();

// check-artifacts は mdast 依存（#403）を持つため静的 import しない。
// npm install 前の fresh clone では解決に失敗する — その場合も fail-open を維持する（CI が最終防衛線）
let checkArtifacts;
let gitChangedFiles;
let gitHeadSha;
try {
  ({ checkArtifacts, gitChangedFiles, gitHeadSha } = await import('../check-artifacts.js'));
} catch {
  failOpen();
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  failOpen();
}

const toolInput = input?.tool_input;
const body = toolInput?.body;
// body を変更しない呼び出し（title のみの update 等）は対象外
if (typeof body !== 'string') failOpen();

// base はブランチ名を期待するが、`origin/main` 形式で渡されると origin/origin/main の
// 不正 ref になり git 失敗→fail-open で検査が素通りするため、プレフィックスを正規化する
const rawBase = typeof toolInput?.base === 'string' && toolInput.base ? toolInput.base : 'main';
const base = rawBase.replace(/^origin\//, '');

// origin/<base> が古いと prose/code 分類を誤り、docs-only PR を誤ブロックしうるため直前に更新する。
// refspec を明示しないと remote-tracking ref（refs/remotes/origin/<base>）が更新されず FETCH_HEAD のみになる。
// --depth=1 はフルクローンを shallow 化し、直後の三点 diff（origin/<base>...HEAD）の merge-base を壊すため付けない。
// fetch 失敗（オフライン等）は手元の ref のまま判定を続行する
try {
  execFileSync('git', ['fetch', '--no-tags', 'origin', `+${base}:refs/remotes/origin/${base}`], {
    stdio: 'ignore',
    timeout: 15000,
  });
} catch {
  // 手元の origin/<base> で続行
}

const changedFiles = gitChangedFiles(`origin/${base}`);
if (changedFiles === null) failOpen();

// #645: Authority receipt の head 束縛検証に使う「現在の PR head」。ローカル HEAD が実際に
// push される head SHA になる前提（create_pull_request/update_pull_request は現在の HEAD を
// push した後に呼ばれる）。`gitHeadSha()`（override 無しの `git rev-parse HEAD` のみ）を使う —
// action/CLI 用の `resolveHeadSha()`（--head-sha 引数 → HEAD_SHA env → git の順）を hook から
// 呼ぶと、セッション環境に `HEAD_SHA` が残っていた場合に古い SHA を「現在の HEAD」と誤って
// 採用してしまう（Codex 指摘: #646。以前は重複実装回避を理由に `resolveHeadSha()` を共有
// していたが、hook の目的は「まさに push される現在の作業ツリー」の検査であり、外部から
// 主張された head 値を信用してはならないため、override を一切通さない下位関数だけを共有する
// 形に変更した）。
// 取得できない場合は null のままにし、checkArtifacts 側は receipt を「束縛できない」＝ stale
// 相当として安全側（legacy Tier）へ倒す（fail-open にはしない — この hook 自体は他の失敗と
// 同じく fail-open だが、headSha 単体の欠落は「検査を諦める」理由にしない。既知の限界:
// update_pull_request で現在のブランチと別の PR の本文を編集する場合、ローカル HEAD がその
// PR の実際の head と一致しないことがある。その場合も CI が正）。
const headSha = gitHeadSha();

const { errors, warnings } = checkArtifacts({ changedFiles, body, headSha });
if (errors.length > 0) {
  console.error('check-pr-body hook: この本文では CI の artifacts-gate が失敗します:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    'PR 本文を修正してから再実行してください（例外は <!-- artifacts-check: skip (理由) --> を明記）。',
  );
  process.exit(2); // exit 2 = ツール呼び出しをブロックし、stderr をエージェントに返す
}
// #645: warnings（Authority receipt が stale/fallback で採用されなかった等）は失敗ではないため
// ブロックしないが、CI の `::warning::` annotation は GitHub Checks UI を開かないと見えない
// （運用性レビュー所見: authority routing の削減が効いていることに誰も気づけない）。
// PreToolUse hook の stderr は exit 2 のときだけエージェントに渡り、exit 0 では
// デバッグログにのみ残りエージェントには渡らない
// （https://code.claude.com/docs/en/hooks.md「Exit Code 0」: stderr is logged to debug only,
// Claude never sees it）。ブロックせずにエージェント自身へ気づかせるには、JSON の
// `hookSpecificOutput.additionalContext` フィールドで stdout へ返す必要がある
// （Codex 指摘: #646。前回の stderr 出力は transcript にしか残らず、意図した事前通知として
// 機能していなかった）。
// `permissionDecision` は絶対に指定しないこと — `"allow"` は「権限確認をスキップして
// 自動許可する」という**権限判断そのもの**であり、単なる非ブロッキング通知ではない
// （Codex 続報指摘: #646。この hook は `.claude/settings.json` で
// `mcp__github__create_pull_request`/`update_pull_request` にマッチしているため、
// 誤って `allow` を返すと本来ユーザーの承認を要する PR 作成・更新が無条件に自動許可されて
// しまっていた）。`permissionDecision` を省略すれば通常の permission flow がそのまま適用される。
if (warnings.length > 0) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: warnings.map((w) => `check-pr-body hook: ⚠ ${w}`).join('\n'),
      },
    })}\n`,
  );
}
process.exit(0);
