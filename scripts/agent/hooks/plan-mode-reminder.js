import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Claude Code UserPromptSubmit hook: plan モードのプロンプトにのみ、実装前ワークフロー
// 規約のリマインダを 1 行注入する（stdout が additionalContext としてエージェントに渡る）。
// plan を書く時点で規約が想起されるようにし、ExitPlanMode でのブロック→修正のやり直しを減らす。
// permission_mode が欠落・非 plan のときは何も出さない（欠落時に毎回注入する誤爆を避け、
// 注入しない側に倒す。強制は check-plan-gates hook が担う）。
// 登録: .claude/settings.json の hooks.UserPromptSubmit

export const REMINDER =
  '[plan モード規約] コード変更を含む計画には risk-modeling / codebase-recon を工程として plan に明記するか、成果物（想定ケース表・既存実装調査表）を plan に埋めること（CLAUDE.md）。ExitPlanMode 時に機械検査されます。';

function main() {
  // 手動実行（stdin が TTY）では readFileSync(0) が入力待ちでハングするため即終了する
  if (process.stdin.isTTY) return;
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf-8'));
  } catch {
    return; // 入力不正時は注入しない
  }
  if (input?.permission_mode === 'plan') process.stdout.write(`${REMINDER}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
