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
try {
  ({ checkArtifacts, gitChangedFiles } = await import('../check-artifacts.js'));
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

const { errors } = checkArtifacts({ changedFiles, body });
if (errors.length > 0) {
  console.error('check-pr-body hook: この本文では CI の artifacts-gate が失敗します:');
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(
    'PR 本文を修正してから再実行してください（例外は <!-- artifacts-check: skip (理由) --> を明記）。',
  );
  process.exit(2); // exit 2 = ツール呼び出しをブロックし、stderr をエージェントに返す
}
process.exit(0);
