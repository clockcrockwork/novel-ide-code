// Artifacts Gate の bundled local action エントリ（#428）。
// mdast 依存を含む検査本体は scripts/agent/check-artifacts.js を単一ソースとし、
// ここでは実行するだけにする（検査ロジックを二重に持たない）。@vercel/ncc が本ファイルを
// 起点に依存を dist/index.js へ束ね、Workflow 実行時の setup-node / npm ci を不要にする。
// 単一ソース方針のため、この action からは呼ばない check-artifacts.js の CLI 専用経路
// （`--verify-proof` 等）も dist に同梱される。この場所が唯一の説明（他ファイルへ複製しない）。
//
// バンドルされる各モジュールの自己起動ガードは basename 判定のため dist/index.js では発火しない
// （check-artifacts.js / classify-changes.js のコメント参照）。runCli は明示的に一度だけ呼ぶ。
import { runCli } from '../../../../scripts/agent/check-artifacts.js';

// 入力契約: JavaScript action の inputs（changed-files / pr-body）を GitHub が
// INPUT_<NAME 大文字・空白→_・ハイフン保持> 環境変数として渡す。既存の runCli は PR_BODY /
// CHANGED_FILES を読むため、ここで INPUT_CHANGED-FILES / INPUT_PR-BODY をマッピングする。
//
// changed-files は action.yml で required にしているため、runner が呼び出し側の「未指定」
// （with: に changed-files キー自体が無い）を検出して action 起動前に fail する。ただし
// action.yml の入力契約（「0件なら空文字列」）が示すとおり、呼び出し元が明示的に空文字列を
// 渡すのは正当なケース（revert で base と等価・base に追いついた PR 等、本当に差分 0 件）
// であり、fail-loud にすると通るべき PR まで落としてしまう（#446 round2 観点別レビュー:
// round1 の throw は過剰だった）。undefined になるのは runner を介さず dist/index.js を
// 直接 node 実行した場合（手動デバッグでの設定漏れ）のみのため、fail-loud はこのケースに限定する。
const rawChangedFiles = process.env['INPUT_CHANGED-FILES'];
if (rawChangedFiles == null) {
  console.error(
    'artifacts-gate: changed-files input が未設定です（呼び出し元 workflow の設定漏れの可能性があります）',
  );
  process.exit(1);
}
// 空文字列は「変更ファイル0件」という正当な値。check-artifacts.js の resolveChangedFiles は
// 空文字列を falsy として git フォールバックへ落とすため、スペース1つへマッピングして
// filter(Boolean) 後に空配列へ解決させる（resolveChangedFiles 側は変更しない）。
process.env.CHANGED_FILES = rawChangedFiles || ' ';

// pr-body は default: '' のため実運用（GitHub Actions 経由）では常に文字列として存在するが、
// runner を介さず dist/index.js を直接 node 実行する場合（手動デバッグ等）は INPUT_PR-BODY が
// undefined になりうる。`process.env.X = undefined` は Node で文字列 "undefined" に強制変換され、
// resolveBody の `!= null` 判定がそれを「PR 本文が指定された」と誤認してしまうため、
// CHANGED_FILES 側と対称に ?? '' でガードする（レビュー指摘・実測確認: undefined 代入で
// process.env.PR_BODY が実際に文字列 "undefined" になることを確認済み）。
process.env.PR_BODY = process.env['INPUT_PR-BODY'] ?? '';

// pr-number / head-sha は required のため常に文字列として存在するが、PR_BODY と同じ理由
// （dist/index.js を runner を介さず直接 node 実行するデバッグ経路での undefined 混入）
// に備えて ?? '' でガードする。
process.env.PR_NUMBER = process.env['INPUT_PR-NUMBER'] ?? '';
process.env.HEAD_SHA = process.env['INPUT_HEAD-SHA'] ?? '';

// runCli() は次の4つが1つでも空なら証明行を出さずに黙って続行する（CLI 単体実行の既存挙動）。
// GitHub Actions 経由のこの action では常に4つとも値を持つはずで、空になるのは呼び出し側
// workflow の受け渡し漏れ・action.yml の required 指定が効かない既知の仕様（actions/runner#924。
// 上記コメント参照）によるものしかありえない。この状態を通すと gate は緑のまま「この run が
// どの PR 状態を検証したか」を誰も確認できなくなる（merge 前確認が異常に気づけない）ため、
// 実行環境が GitHub Actions（`GITHUB_ACTIONS` 環境変数で判定）のときだけ、証明行が出ない
// 状態そのものを fail-loud にする（runner を介さない手動デバッグ実行では従来どおり許容する）。
const PROOF_LINE_REQUIRED_VARS = ['PR_NUMBER', 'HEAD_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
const missingProofLineVars = PROOF_LINE_REQUIRED_VARS.filter((name) => !process.env[name]);
if (process.env.GITHUB_ACTIONS && missingProofLineVars.length > 0) {
  console.error(
    `artifacts-gate: ${missingProofLineVars.join('/')} が空です。呼び出し元 workflow の with: または実行環境を確認してください（証明行が出せないまま gate を通過させない）。`,
  );
  process.exit(1);
}

runCli();
