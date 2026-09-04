import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { checkArtifacts } from '../scripts/agent/check-artifacts.js';
import { buildBody, evidenceTable } from './helpers/checkArtifactsBody.js';

// 敵対的スイープの表駆動ハーネス（issue #401）。
//
// PR #396 のレビューループでは、ガード（scripts/agent/check-artifacts.js の正規表現・分類器）を
// 修正するたびに「正例（受理されるべき）/ 負例（拒否されるべき）」のペアを scratchpad に手書きして
// checkArtifacts() に流す敵対的スイープを毎ラウンド繰り返していた。そのケースをここに常設し、
// 以後ガードを触るときは「境界差分＝新たに受理/拒否される入力クラス」をこの表への行追加で表現する。
//
// ケース schema:
//   { name, input: { evidence?, loop?, issue? }, changedFiles?, expect: 'accept' | 'reject', errorIncludes? }
//   - input は buildBody() のスロット差し替え部品。指定しないスロットは受理される既定値になる。
//   - expect: 'accept' → エラー0（deepEqual([])）/ 'reject' → errorIncludes の各部分文字列を含む
//   - errorIncludes: string | string[]（reject 時必須。実在するエラー文言の distinctive fragment）
//
// 実在するエラー部分文字列（scripts/agent/check-artifacts.js）:
//   証拠表: 「チェック済み項目に証拠がありません」（- [x] 形式）/「完了主張の行に証拠がありません」（表形式）
//   ループ: 「収束宣言がありません」/「新規所見がゼロ表記」/「標準形式」
//   issue:  「関連 issue」
//   Tier:   「Tier 宣言行がありません」/「Tier 宣言が競合」/「判定理由が空」/「必須の系統」/
//           「系統列がありません」/「Tier 宣言は」（宣言名と分類の不一致）（#452）

// --- ファミリ1: 証拠ポインタ / soft claim（証拠の弱トークン・宣言のみ・コマンド認識） ---

const NO_EVIDENCE_TABLE = '完了主張の行に証拠がありません';
const NO_EVIDENCE_CHECK = 'チェック済み項目に証拠がありません';

const evidencePointerCases = [
  // #395: skip 語で始まるが実ポインタを併記していれば通る（偽陽性修正）
  {
    name: '#395: 表セル「OK、tests/... で確認」は実ポインタあり → 受理',
    input: { evidence: evidenceTable('OK、tests/foo.test.js で確認') },
    expect: 'accept',
  },
  {
    name: '#395: 「完了（npm run lint: 0 errors）」は受理',
    input: { evidence: '- [x] lint — 完了（npm run lint: 0 errors）' },
    expect: 'accept',
  },
  // 接頭辞付き soft claim（証拠ポインタなし）は拒否
  ...['手動で動作確認', 'ローカルで確認', '実機で確認済み'].map((claim) => ({
    name: `soft claim（接頭辞付き・ポインタなし）: ${claim} → 拒否`,
    input: { evidence: evidenceTable(claim) },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  })),
  {
    name: 'soft claim（接頭辞付き）でも証拠ポインタ併記なら受理',
    input: { evidence: '- [x] 手動で動作確認 — tests/x.test.js で確認' },
    expect: 'accept',
  },
  {
    name: '区切りなしで証拠トークンもない完了主張 → 拒否',
    input: { evidence: '- [x] ビルドが通ることをこの目で確認' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: 'hard deferral「N/A: npm run lint は不要」はコマンド併記でも拒否（未実施宣言）',
    input: { evidence: evidenceTable('N/A: npm run lint は不要') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  // 弱いトークン（日付・時刻・バッククォート・ライブラリ名）で soft claim を通さない
  ...[
    '確認済み 2026/07/09',
    'OK 14:30 時点で確認',
    '確認済み（`目視`）',
    'done, Node.js で確認',
    '目視',
    '動作確認済み',
    'OK（3/4.5 相当）',
  ].map((ev) => ({
    name: `弱トークンで soft claim を通さない: ${ev} → 拒否`,
    input: { evidence: evidenceTable(ev) },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  })),
  {
    name: 'Windows 形式のバックスラッシュパスも証拠として認識 → 受理',
    input: { evidence: '- [x] 確認済み — tests\\foo.test.js で確認' },
    expect: 'accept',
  },
  {
    name: '証拠が skip 語のみ（「OK」単体）→ 拒否',
    input: { evidence: evidenceTable('OK') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  // 宣言のみ（テストパス/ビルド成功 等）は証拠ポインタなしなら拒否
  ...['テストパス', 'ビルド成功', '成功しました', 'テスト完了'].map((claim) => ({
    name: `宣言のみ（ポインタなし）: ${claim} → 拒否`,
    input: { evidence: evidenceTable(claim) },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  })),
  {
    name: 'コマンドの空白揺れ（npm  run）も証拠として認識 → 受理',
    input: { evidence: '- [x] テストパス — npm  run test で確認（601 pass）' },
    expect: 'accept',
  },
  {
    name: 'ルート直下ファイルの行番号付き参照（package.json:16）→ 受理',
    input: { evidence: '- [x] engines 確認 — 確認済み package.json:16' },
    expect: 'accept',
  },
  // 行番号なしの単一セグメント（Node.js 型）は証拠と認めない
  ...['Node.js', 'README.md', 'package.json'].map((token) => ({
    name: `行番号なしの単一セグメント: ${token} → 拒否`,
    input: { evidence: evidenceTable(`確認済み ${token}`) },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  })),
  {
    name: '`npm run`（script 名なし）単体は証拠と認めない → 拒否',
    input: { evidence: evidenceTable('確認済み npm run') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  // `npm run <script>` / `npm test` / `npm ci` は証拠として認める
  ...['npm run lint', 'npm  run  test', 'npm test', 'npm ci'].map((cmd) => ({
    name: `正当なコマンド: ${cmd} → 受理`,
    input: { evidence: `- [x] 検証 — 確認済み ${cmd}` },
    expect: 'accept',
  })),
  {
    name: '`npm run --if-present`（オプションのみ・script 名なし）は証拠と認めない → 拒否',
    input: { evidence: evidenceTable('確認済み npm run --if-present') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  {
    name: '`npm run <script>` はオプション付きでも script 名があれば受理',
    input: { evidence: '- [x] 検証 — 確認済み npm run test --if-present' },
    expect: 'accept',
  },
  {
    name: '先頭ハイフン付きの正当な証拠（- tests/foo.test.js）を誤って拒否しない → 受理',
    input: { evidence: '- [x] X — - tests/foo.test.js で確認' },
    expect: 'accept',
  },
  {
    name: '単独ハイフン「-」はプレースホルダとして拒否',
    input: { evidence: evidenceTable('-') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  {
    name: '全角文字を含むファイル名（docs/マニュアル.md）も証拠として認識 → 受理',
    input: { evidence: '- [x] 確認 — docs/マニュアル.md に記載' },
    expect: 'accept',
  },
  {
    name: '証拠内に区切り文字（コロン等）を含むパスが空白へ潰れない → 受理',
    input: { evidence: '- [x] 実行 — 出力: src/foo.js:42 で確認' },
    expect: 'accept',
  },
  {
    name: 'チェック済み [x] の証拠が「確認済み」（skip 語）→ 拒否',
    input: { evidence: '- [x] lint 実行 — 確認済み' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: 'チェック済み [x] に証拠がない（ビルド成功のみ）→ 拒否',
    input: { evidence: '- [x] ビルド成功' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: 'チェック済み [x] が N/A（未実施の成功偽装）→ 拒否',
    input: { evidence: '- [x] ビルド成功 — N/A（docs のみ）' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: 'チェック済み [x] に証拠ポインタあり → 受理',
    input: { evidence: '- [x] lint 実行 — npm run lint の出力: OK' },
    expect: 'accept',
  },
];

// --- ファミリ2: 区切り記法（ラベルと証拠の区切り認識） ---

const delimiterCases = [
  {
    name: '区切りなし記法はラベル内にパスがあっても証拠なし（自己証明の穴防止）→ 拒否',
    input: { evidence: '- [x] src/lib/db.js を修正済み' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: '区切りなし記法は行番号付きパス（file:line）でも自己証明を許さない → 拒否',
    input: { evidence: '- [x] src/lib/db.js:42 を修正済み' },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_CHECK,
  },
  {
    name: '日本語IMEの全角ダッシュ（―U+2015）も区切りとして認識 → 受理',
    input: { evidence: '- [x] 実行 ― src/foo.js で確認' },
    expect: 'accept',
  },
];

// --- ファミリ3: 関連 issue 参照 ---

const ISSUE_MISSING = '関連 issue';

const issueRefCases = [
  {
    name: '#番号 も「なし宣言」もない → 拒否',
    input: { issue: '' },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  },
  {
    name: '「関連issue: なし（理由）」宣言があれば受理',
    input: { issue: '関連issue: なし（typo 修正のみ）' },
    expect: 'accept',
  },
  {
    name: '色コード #333 だけでは参照とみなさない（キーワード近傍が必要）→ 拒否',
    input: { issue: '背景を #333 から #444 に変更' },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  },
  {
    name: '「fix color #333」の近傍一致では参照とみなさない（# 直結のみ）→ 拒否',
    input: { issue: 'fix color #333 の変更です' },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  },
  {
    name: '「prefix #12」の部分文字列 fix では参照とみなさない（語境界必須）→ 拒否',
    input: { issue: 'prefix #12 を調整' },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  },
  // キーワード直結形は受理
  ...['closes #333', '対応 issue: #12'].map((ref) => ({
    name: `キーワード近傍の参照: ${ref} → 受理`,
    input: { issue: ref },
    expect: 'accept',
  })),
  {
    name: 'テンプレ HTML コメント内の「関連issue: なし（理由）」例示だけでは通さない → 拒否',
    input: {
      issue:
        '<!-- closes #番号 / refs #番号 の形式で書く。対応 issue がない場合は「関連issue: なし（理由）」と書く -->',
    },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  },
  // なし宣言の括弧が空白のみ（半角/全角/空）なら通さない
  ...['関連issue: なし（ ）', '関連issue: なし（　）', '関連issue: なし()'].map((decl) => ({
    name: `なし宣言の空理由: 「${decl}」→ 拒否`,
    input: { issue: decl },
    expect: 'reject',
    errorIncludes: ISSUE_MISSING,
  })),
  {
    name: 'なし宣言に実質的な理由があれば受理',
    input: { issue: '関連issue: なし（試験的な内部ツールのため）' },
    expect: 'accept',
  },
];

// --- ファミリ4: 収束宣言 / 新規所見（レビューループ記録の最終行の受理文法） ---

const NO_CONVERGENCE = '収束宣言がありません';
const NOT_ZERO = '新規所見がゼロ表記';
const NOT_STANDARD = '標準形式';

const STD_HEADER = `| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|`;
// Light フロアを充足する系統セル（5系統連結。#452/Phase2 で系統列が必須になったため、収束文法
// ファミリのケースはこのセルを注入して系統検査を素通しし、収束文法の判定だけを検査する）
const LIGHT_ANGLES = '減算＋敵対的＋risk-model 検証＋コード品質＋清掃';
// 全セル空のプレースホルダ行（`|  |  |  |`）はそのまま残す（系統セルを注入すると非空行に
// 化けて「最終行と誤認しない」ケースの検査対象が変わってしまう）
const withAngleCell = (row) =>
  /^\|[\s|]*\|$/.test(row.trim())
    ? row
    : row.replace(/^\|\s*([^|]*?)\s*\|/, `| $1 | ${LIGHT_ANGLES} |`);
// Tier 宣言行＋標準ヘッダ＋任意の最終行でループセクションを組む（行には系統セルを注入する）
const loopWith = (finalRow) =>
  `Tier: Light（スイープ用）\n\n${STD_HEADER}\n${finalRow.split('\n').map(withAngleCell).join('\n')}`;

const convergenceCases = [
  {
    name: '収束宣言がない（最終行の対応が「全修正」）→ 拒否',
    input: { loop: loopWith('| 1 | 4件 | 全修正 |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  // 「未収束」系は収束宣言として通さない
  ...['未収束', 'まだ収束していない', '収束せず（続行）'].map((cell) => ({
    name: `「${cell}」は収束宣言として通さない → 拒否`,
    input: { loop: loopWith(`| 1 | 4件 | ${cell} |`) },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  })),
  {
    name: '上限超過でも残所見を実質列挙していれば受理',
    input: {
      loop: loopWith(
        '| 3 | 2件 | 上限到達。残所見: foo.js:10 の X / bar.js:20 の Y（ユーザー判断待ち） |',
      ),
    },
    expect: 'accept',
  },
  {
    name: '途中行の「残所見を全修正」（コロンなし）は収束扱いにしない → 拒否',
    input: { loop: loopWith('| 1 | 2件 | 残所見を全修正 |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  {
    name: '最終行が「収束」でも新規所見が非ゼロ（3件）→ 拒否',
    input: { loop: loopWith('| 5 | 3件 | 収束 |') },
    expect: 'reject',
    errorIncludes: NOT_ZERO,
  },
  {
    name: '説明文付きの新規所見セル（0件（…））は受理文法外 → 拒否',
    input: { loop: loopWith('| 2 | 0件（敵対的スイープ5形ミスマッチ0） | 収束 |') },
    expect: 'reject',
    errorIncludes: NOT_ZERO,
  },
  // 新規所見セルの数字以外の自由記述は受理文法外
  ...['なし', 'ゼロ', '新規所見なし'].map((cell) => ({
    name: `新規所見セルの自由記述「${cell}」は受理文法外 → 拒否`,
    input: { loop: loopWith(`| 2 | ${cell} | 収束 |`) },
    expect: 'reject',
    errorIncludes: NOT_ZERO,
  })),
  // 新規所見セルは数字のみ（0 / 0件 / 装飾付き）を受理
  ...['0', '0件', '0 件', '**0**'].map((cell) => ({
    name: `新規所見セルのゼロ表記「${cell}」→ 受理`,
    input: { loop: loopWith(`| 2 | ${cell} | 収束 |`) },
    expect: 'accept',
  })),
  // 空の「残所見:」宣言は収束扱いにしない
  ...['残所見:', '残所見：', '上限到達。残所見: '].map((cell) => ({
    name: `空の残所見宣言「${cell}」は収束扱いにしない → 拒否`,
    input: { loop: loopWith(`| 3 | 2件 | ${cell} |`) },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  })),
  // 残所見のプレースホルダ語（なし/-/N/A/TODO）は列挙とみなさず拒否
  ...['残所見: なし', '残所見: -', '残所見: N/A', '残所見: TODO', '上限到達。残所見: なし'].map(
    (cell) => ({
      name: `残所見プレースホルダ「${cell}」→ 拒否`,
      input: { loop: loopWith(`| 3 | 2件 | ${cell} |`) },
      expect: 'reject',
      errorIncludes: NO_CONVERGENCE,
    }),
  ),
  {
    name: '残所見の実質的な列挙は受理',
    input: {
      loop: loopWith('| 3 | 2件 | 上限到達。残所見: foo.js:10 の X / bar.js:20 の Y |'),
    },
    expect: 'accept',
  },
  {
    name: '対応列以外のセルの「収束」（| 1 | 0件 | 未収束 | 収束 |）→ 拒否',
    input: { loop: loopWith('| 1 | 0件 | 未収束 | 収束 |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  {
    name: 'エスケープ済みパイプ（未\\|収束）を収束セル境界と誤認しない → 拒否',
    input: { loop: loopWith('| 1 | 0件 | 未\\| 収束 |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  // 打ち消し線（取り消された宣言）は拒否
  {
    name: '打ち消し線 ~~収束~~ は取り消された対応宣言 → 拒否',
    input: { loop: loopWith('| 1 | 0件 | ~~収束~~ |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  {
    name: '打ち消し線 ~~0件~~ は取り消された所見表記 → 拒否',
    input: { loop: loopWith('| 1 | ~~0件~~ | 収束 |') },
    expect: 'reject',
    errorIncludes: NOT_ZERO,
  },
  // 太字/斜体/コードの装飾は引き続き受理
  ...['**収束**', '_収束_', '`収束`'].map((cell) => ({
    name: `対応セルの装飾「${cell}」は受理`,
    input: { loop: loopWith(`| 1 | 0件 | ${cell} |`) },
    expect: 'accept',
  })),
  {
    name: '旧ラウンドの「収束」セルが残ったまま新ラウンド行を追記しても最終行で判定 → 拒否',
    input: { loop: loopWith('| 1 | 0件 | 収束 |\n| 2 | 3件 | 全修正 |') },
    expect: 'reject',
    errorIncludes: NO_CONVERGENCE,
  },
  {
    name: 'テンプレの空プレースホルダ行が有効行の後に残っていても最終行と誤認しない → 受理',
    input: { loop: loopWith('| 1 | 0件 | 収束 |\n|  |  |  |') },
    expect: 'accept',
  },
  {
    name: '非ゼロ所見の行に末尾セルで「0件」を後置しても収束扱いにしない → 拒否',
    input: { loop: loopWith('| 5 | 3件 | 収束 | 0件 |') },
    expect: 'reject',
    errorIncludes: NOT_ZERO,
  },
  // ヘッダを欠いた表はゼロ所見判定を迂回できない（標準形式へ誘導）
  {
    name: 'ヘッダなし表の末尾「0件」セル後置ではゼロ所見確認を迂回できない → 拒否',
    input: { loop: '|---|---|---|\n| 5 | 3件 | 収束 | 0件 |' },
    expect: 'reject',
    errorIncludes: NOT_STANDARD,
  },
  {
    name: 'ヘッダなし表の周回番号 0 をゼロ所見と誤認しない → 拒否',
    input: { loop: '|---|---|---|\n| 0 | 3件 | 収束 |' },
    expect: 'reject',
    errorIncludes: NOT_STANDARD,
  },
  {
    name: '非テーブル自由記述の最終行「収束」単独ではゼロ所見確認を迂回できない → 拒否',
    input: { loop: '1周目: 新規所見 3件、全修正\n\n収束' },
    expect: 'reject',
    errorIncludes: NOT_STANDARD,
  },
];

// --- ファミリ5: 証拠表への「前提」列追加（issue #405） ---
// 判断記録に「前提（＋失効条件）」欄を導入する改訂で、証拠表に任意の「前提」列を足す。
// check-artifacts の列検出はヘッダの部分一致（宣言 / 証拠 / 判定）で行うため、4 列目を足しても
// 証拠列の位置検出は壊れず、証拠欠落は従来どおり落ちる——という非破壊性を機械で固定する。
const evidenceTable4 = (cell) => `| 宣言 | 証拠 | 判定 | 前提 |
|---|---|---|---|
| X | ${cell} | ✅ | 前提: A が B である限り不要 |`;

const premiseColumnCases = [
  {
    name: '#405: 前提列付き証拠表（4列）でも実ポインタありなら従来どおり受理',
    input: { evidence: evidenceTable4('scripts/x.js:10 / tests/x.test.js') },
    expect: 'accept',
  },
  {
    name: '#405: 前提列付き証拠表（4列）で証拠セルが soft claim のみなら従来どおり拒否',
    input: { evidence: evidenceTable4('動作確認済み') },
    expect: 'reject',
    errorIncludes: NO_EVIDENCE_TABLE,
  },
  {
    name: '#405: 前提セルが空でも証拠ポインタがあれば受理（前提は任意列）',
    input: {
      evidence: `| 宣言 | 証拠 | 判定 | 前提 |
|---|---|---|---|
| X | tests/x.test.js | ✅ |  |`,
    },
    expect: 'accept',
  },
];

// --- ファミリ6: Tier 宣言×系統列の突き合わせ（issue #452） ---
// 境界差分: 本改修で「新たに拒否される入力クラス」= Tier 宣言の欠落/競合/分類不一致・
// 必須系統の実施行欠落・系統列欠落。「新たに受理される入力クラス」= 閉じたトークン
// （短縮形/正式名/装飾付き/全角半角＋区切り）・免除宣言・設計文書 Tier の最小本文。

const NO_TIER = 'Tier 宣言行がありません';
const TIER_CONFLICT = 'Tier 宣言が競合';
const TIER_REASON = '判定理由が空';
const ANGLE_MISSING = '必須の系統';
const NO_ANGLE_COL = '系統列がありません';

// Tier 行と表を自由に組むための生ビルダー（loopWith は Tier 行と系統セルを自動注入するため、
// Tier×系統ファミリでは使わない）
const rawLoop = (tierLine, rows) => `${tierLine}\n\n${STD_HEADER}\n${rows}`;
const FLOOR_ROWS = `| 1 | 敵対的 | 1件 | 全修正 |
| 1 | risk-model 検証 | 1件 | 全修正 |
| 1 | コード品質 | 1件 | 全修正 |
| 2 | ${LIGHT_ANGLES} | 0件 | 収束 |`;

const tierAngleCases = [
  {
    name: '#452: Tier 宣言行なし → 拒否',
    input: { loop: `${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |` },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: HTML コメント内の Tier 行は宣言と数えない → 拒否',
    input: {
      loop: `<!-- Tier: Light（例） -->\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: Tier 宣言の競合（Light と Full）→ 拒否',
    input: { loop: rawLoop('Tier: Light（a）\n\nTier: Full（b）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: TIER_CONFLICT,
  },
  {
    name: '#452: 同値の Tier 宣言の重複は競合にしない → 受理',
    input: { loop: rawLoop('Tier: Light（a）\n\nTier: Light（a）', FLOOR_ROWS) },
    expect: 'accept',
  },
  // 判定理由の空・プレースホルダは拒否
  ...['Tier: Light（なし）', 'Tier: Light（TODO）', 'Tier: Light（ ）'].map((line) => ({
    name: `#452: 判定理由がプレースホルダ「${line}」→ 拒否`,
    input: { loop: rawLoop(line, FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: [TIER_REASON],
  })),
  {
    name: '#452: コード PR に「設計文書」宣言 → 拒否（分類との不一致）',
    input: { loop: rawLoop('Tier: 設計文書（誤宣言）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: 'Tier 宣言は',
  },
  {
    name: '#452: 列挙外での「Light＋設計文書」宣言は受理するが加算系統の実施は要求（README の広げる裁量）',
    input: {
      loop: rawLoop(
        'Tier: Light＋設計文書（列挙外の拘束成果物に接触・列挙追加を issue 提案）',
        FLOOR_ROWS,
      ),
    },
    expect: 'reject',
    errorIncludes: ['必須の系統'],
  },
  {
    name: '#452: 列挙外での「Light＋設計文書」宣言＋5系統実施 → 受理（広げる方向の裁量）',
    input: {
      loop: rawLoop(
        'Tier: Light＋設計文書（列挙外の拘束成果物に接触）',
        `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 1件 | 全修正 |
| 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: Full 宣言で仕様・運用性の実施行が無い → 拒否',
    input: { loop: rawLoop('Tier: Full（高リスク領域）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: [ANGLE_MISSING],
  },
  {
    name: '#452: Full 宣言で5系統の実施行が揃えば受理',
    input: {
      loop: rawLoop(
        'Tier: Full（高リスク領域）',
        `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 1件 | 全修正 |
| 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: 系統列のない旧3列形式 → 拒否（系統列を要求）',
    input: {
      loop: `Tier: Light（旧形式）\n\n| 周回 | 新規所見 | 対応 |\n|---|---|---|\n| 1 | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_ANGLE_COL,
  },
  // 受理トークン: 短縮形・正式名・装飾・半角プラス区切り
  {
    name: '#452: 短縮形トークン（品質・risk-model・運用性なし Light）→ 受理',
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | 減算 | 1件 | 全修正 |
| 1 | 敵対的 | 1件 | 全修正 |
| 1 | risk-model | 1件 | 全修正 |
| 1 | 品質 | 1件 | 全修正 |
| 1 | 清掃 | 1件 | 全修正 |
| 2 | 減算＋敵対的＋risk-model＋品質＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: 装飾付きトークン（**敵対的**）も受理',
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | **敵対的** | 1件 | 全修正 |
| 1 | risk-model 検証、コード品質 | 1件 | 全修正 |
| 2 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: 半角プラス区切り（敵対的+risk-model 検証+コード品質）も受理',
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | 減算+敵対的+risk-model 検証+コード品質+清掃 | 1件 | 全修正 |
| 2 | 減算+敵対的+risk-model 検証+コード品質+清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  // コーパス実在の自由記述は不受理（起動証跡に数えない）
  ...['riskmodel 再照合 (self)', 'docs 整合', 'spec (issue完了条件との突き合わせ・self)'].map(
    (tok) => ({
      name: `#452: 自由記述トークン「${tok}」はフロア充足に数えない → 拒否`,
      input: {
        loop: rawLoop('Tier: Light（通常コード変更）', `| 1 | ${tok} | 0件 | 収束 |`),
      },
      expect: 'reject',
      errorIncludes: [ANGLE_MISSING],
    }),
  ),
  {
    name: '#452: ホワイトリスト外トークン（/security-review）はエラーにせず無視（フロア行が別にあれば受理）',
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | /security-review | 1件 | 全修正 |
${FLOOR_ROWS}`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: 打ち消し線の系統セル（~~敵対的~~）は実施記録に数えない → 拒否',
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | ~~敵対的~~ | 1件 | 全修正 |
| 1 | risk-model 検証＋コード品質 | 1件 | 全修正 |
| 2 | risk-model 検証＋コード品質 | 0件 | 収束 |`,
      ),
    },
    expect: 'reject',
    errorIncludes: [ANGLE_MISSING],
  },
  // Tier 宣言の検出境界（1周目レビュー所見: 打ち消し線・非宣言文脈・誤診断・全半角）
  {
    name: '#452: 打ち消し線の Tier 宣言（~~Tier: Light（…）~~）は宣言と数えない → 拒否',
    input: {
      loop: `~~Tier: Light（取り消した宣言）~~\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: 打ち消した旧宣言＋有効な新宣言は競合にならない（正当な訂正）→ 受理',
    input: {
      loop: `~~Tier: Full（当初判定）~~\n\nTier: Light（再分類: 高リスク領域外）\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'accept',
  },
  {
    name: '#452: コードフェンス内の Tier 行は例示であり宣言と数えない → 拒否',
    input: {
      loop: `\`\`\`markdown\nTier: Light（テンプレ例示）\n\`\`\`\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: インラインコード内の Tier 記述（書式説明）は宣言と数えない → 拒否',
    input: {
      loop: `書式は \`Tier: Light（判定理由1行）\` を使う\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: 引用ブロック内の Tier 行（他者コメントの引用）は宣言と数えない → 拒否',
    input: {
      loop: `> Tier: Light（他者の引用）\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: 表セル内の Tier 記述は宣言と数えない → 拒否',
    input: {
      loop: `${STD_HEADER}\n| 1 Tier: Light（セル内） | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452: 地の文中の Tier 言及（行頭でない）は宣言・競合と数えない → 受理',
    input: {
      loop: `Tier: Light（再分類済み）\n\n1周目時点の判定は Tier: Full（高リスク疑い）だったが再分類した。\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'accept',
  },
  {
    name: '#452: 理由に括弧を含む宣言は「書式外」エラーに誘導（「ありません」と誤診断しない）→ 拒否',
    input: { loop: rawLoop('Tier: Light（fix (regex) 対応）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: '受理文法外',
  },
  {
    name: '#452: 半角プラスの宣言名（Light+設計文書）も受理（系統セル区切りと同じ許容度）',
    changedFiles: ['src/a.js', 'docs/planning/x.md'],
    input: {
      loop: rawLoop(
        'Tier: Light+設計文書（混在）',
        `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  // 2周目境界差分: 装飾前置による行アンカー偽装（除去→連結の穴）と誤ブロック
  {
    name: '#452-r2: 装飾前置の Tier 言及（`補足` Tier: Full…）は宣言化せず偽競合しない → 受理',
    input: {
      loop: `Tier: Light（正規の宣言）\n\n\`補足\` Tier: Full（当初の判定メモ）\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'accept',
  },
  {
    name: '#452-r2: 打ち消し前置の免除宣言（~~却下~~ Tier: なし…）は宣言化しない → 拒否',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: { loop: '~~却下~~ Tier: なし（説明・記録文書: 免除したつもり）' },
    expect: 'reject',
    errorIncludes: NO_TIER,
  },
  {
    name: '#452-r2: プレースホルダ語で始まる正当な理由（未使用コード削除のみ）を誤ブロックしない → 受理',
    input: { loop: rawLoop('Tier: Light（未使用コード削除のみ）', FLOOR_ROWS) },
    expect: 'accept',
  },
  {
    name: '#452-r2: プレースホルダ語で始まる正当な免除理由（未公開メモの整理）→ 受理',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: { loop: 'Tier: なし（説明・記録文書: 未公開メモの整理）' },
    expect: 'accept',
  },
  {
    name: '#452-r2: 免除宣言と実施記録の表の併存は矛盾として拒否（免除への降格脱出路）',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: {
      loop: `Tier: なし（説明・記録文書: レビュー途中で免除に切替）\n\n${STD_HEADER}\n| 1 | 仕様＋運用性 | 3件 | 未対応 |`,
    },
    expect: 'reject',
    errorIncludes: '併存',
  },
  {
    name: 'Phase2/清掃レビュー対応: Record mandate の免除・実施記録併存エラーは「Tier: Record」を案内する',
    changedFiles: ['docs/agent-memory/records/x.json'],
    input: {
      loop: `Tier: なし（説明・記録文書: レビュー途中で免除に切替）\n\n${STD_HEADER}\n| 1 | 減算 | 3件 | 未対応 |`,
    },
    expect: 'reject',
    errorIncludes: ['併存', 'Tier: Record'],
  },
  {
    name: 'Phase2/清掃レビュー対応: Docs mandate の免除・実施記録併存エラーは「Tier: Docs」を案内する',
    changedFiles: ['docs/README.md'],
    input: {
      loop: `Tier: なし（説明・記録文書: レビュー途中で免除に切替）\n\n${STD_HEADER}\n| 1 | 清掃 | 3件 | 未対応 |`,
    },
    expect: 'reject',
    errorIncludes: ['併存', 'Tier: Docs'],
  },
  {
    name: '#452-r2: 箇条書きに書かれた宣言意図は「ありません」でなく書式誘導エラー → 拒否',
    input: {
      loop: `- Tier: Light（箇条書きで書いた）\n\n${STD_HEADER}\n| 1 | ${LIGHT_ANGLES} | 0件 | 収束 |`,
    },
    expect: 'reject',
    errorIncludes: '受理文法外',
  },
  // 3周目境界差分: 境界マーカーによる理由偽装・非正準ヘッダ併存・未着手・ハードブレイク
  ...['`なし`', '~~todo~~', '<!--x-->'].map((deco) => ({
    name: `#452-r3: 理由欄を装飾（${deco}）で偽装した宣言は非空検査を素通りしない → 拒否`,
    input: { loop: rawLoop(`Tier: Light（${deco}）`, FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: TIER_REASON,
  })),
  {
    name: '#452-r3: 理由に装飾を含む正当な理由（`fix` を適用）は受理',
    input: { loop: rawLoop('Tier: Light（`fix` を適用）', FLOOR_ROWS) },
    expect: 'accept',
  },
  // 「見た目は空」の不可視・空白偽装（ゼロ幅・点字空白・フィラー・soft hyphen・NBSP・全角）は
  // すべて空扱いで拒否（肯定的不変条件: 可視グリフが1つも無い理由は非理由。4〜5周目 A-r4-1/A-r5-1）
  ...['​', '⁠', '﻿', '⠀', 'ㅤ', '᠎', '­', ' ', '　'].map((zw) => ({
    name: `#452: 理由が不可視/空白文字（U+${zw.codePointAt(0).toString(16)}）のみは空扱いで拒否`,
    input: { loop: rawLoop(`Tier: Light（${zw}）`, FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: TIER_REASON,
  })),
  ...['́', '⃝'].map((cm) => ({
    name: `#452: 単独結合文字（U+${cm.codePointAt(0).toString(16)}）のみの理由は空扱いで拒否`,
    input: { loop: rawLoop(`Tier: Light（${cm}）`, FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: TIER_REASON,
  })),
  ...['🎉', '修正', '80%削減', 'café'].map((r) => ({
    name: `#452: 可視グリフを含む理由（${r}）は受理`,
    input: { loop: rawLoop(`Tier: Light（${r}）`, FLOOR_ROWS) },
    expect: 'accept',
  })),
  {
    name: '#452-r3: 免除理由を装飾で偽装（説明・記録文書: <!--x-->）は免除と認めない → 拒否',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: { loop: 'Tier: なし（説明・記録文書: <!--x-->）' },
    expect: 'reject',
    errorIncludes: '閉じた書式',
  },
  {
    name: '#452-r3: 理由「未着手」はプレースホルダとして拒否',
    input: { loop: rawLoop('Tier: Light（未着手）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: TIER_REASON,
  },
  {
    name: '#452-r3: 非正準ヘッダ（周回→回）の実施表と免除宣言の併存も拒否',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: {
      loop: `Tier: なし（説明・記録文書: 途中で免除に切替）\n\n| 回 | 系統 | 新規所見 | 対応 |\n|---|---|---|---|\n| 1 | 仕様＋運用性 | 3件 | 未対応 |`,
    },
    expect: 'reject',
    errorIncludes: '併存',
  },
  // 免除の検出境界
  {
    name: '#452: 免除理由のプレースホルダ（説明・記録文書: TODO）は免除と認めない → 拒否',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: { loop: 'Tier: なし（説明・記録文書: TODO）' },
    expect: 'reject',
    errorIncludes: '閉じた書式',
  },
  {
    name: '#452: 免除理由のテンプレ丸写し（説明・記録文書: 理由）は免除と認めない → 拒否',
    changedFiles: ['docs/agent-workflows/x.md'],
    input: { loop: 'Tier: なし（説明・記録文書: 理由）' },
    expect: 'reject',
    errorIncludes: '閉じた書式',
  },
  {
    name: '#452: depOnly×設計文書の混在では免除不可 → 拒否',
    changedFiles: ['package.json', 'package-lock.json', 'docs/planning/x.md'],
    input: { loop: 'Tier: なし（説明・記録文書: 依存更新のついで）' },
    expect: 'reject',
    errorIncludes: 'docs のみの PR に限ります',
  },
  {
    name: '#452/Phase2: depOnly×設計文書は宣言名「設計文書」＋減算・仕様・運用性・清掃で受理',
    changedFiles: ['package.json', 'package-lock.json', 'docs/planning/x.md'],
    input: {
      loop: rawLoop(
        'Tier: 設計文書（依存更新＋設計文書。コード Tier なし）',
        `| 1 | 減算＋仕様＋運用性＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: 'Phase2: depOnly×Record は宣言名「Record」＋減算・清掃で受理',
    changedFiles: ['package.json', 'package-lock.json', 'docs/agent-memory/records/x.json'],
    input: {
      loop: rawLoop(
        'Tier: Record（依存更新＋記憶レコード。コード Tier なし）',
        `| 1 | 減算＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: 'Phase2: depOnly×Docs は宣言名「Docs」＋清掃で受理',
    changedFiles: ['package.json', 'package-lock.json', 'docs/README.md'],
    input: {
      loop: rawLoop(
        'Tier: Docs（依存更新＋説明文書。コード Tier なし）',
        `| 1 | 清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: 'Phase2: Docs 判定の変更を著者が Record（新規則の追加等）へ自主的に引き上げ → 受理',
    changedFiles: ['docs/README.md'],
    input: {
      loop: rawLoop(
        'Tier: Record（Docs 判定だが新しい必須手順を追加するため引き上げ）',
        `| 1 | 減算＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: 'Phase2: Record 判定を Docs へ宣言（引き下げ）は拒否',
    changedFiles: ['docs/agent-memory/records/x.json'],
    input: { loop: rawLoop('Tier: Docs（記録なので簡略化）', `| 1 | 清掃 | 0件 | 収束 |`) },
    expect: 'reject',
    errorIncludes: 'Tier 宣言は',
  },
  // 混在 PR（コード＋設計文書）
  {
    name: '#452: 混在 PR で「Light」単独宣言 → 拒否（＋設計文書を要求）',
    changedFiles: ['src/a.js', 'docs/planning/x.md'],
    input: { loop: rawLoop('Tier: Light（通常コード変更）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: '＋設計文書',
  },
  {
    name: '#452: 混在 PR の「Light＋設計文書」宣言＋5系統実施 → 受理',
    changedFiles: ['src/a.js', 'docs/planning/x.md'],
    input: {
      loop: rawLoop(
        'Tier: Light＋設計文書（通常コード変更＋設計文書に接触）',
        `| 1 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 1件 | 全修正 |
| 2 | 減算＋敵対的＋risk-model 検証＋コード品質＋仕様＋運用性＋清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: '#452: 混在 PR で加算分（仕様・運用性）の実施行が無い → 拒否',
    changedFiles: ['src/a.js', 'docs/planning/x.md'],
    input: { loop: rawLoop('Tier: Light＋設計文書（混在）', FLOOR_ROWS) },
    expect: 'reject',
    errorIncludes: [ANGLE_MISSING],
  },
  // 系統別「直近の実施行」の収束確認（外部レビュー Codex #539 指摘: 必須系統がどこかに
  // 登場するだけで満たしたことにすると、未解決のまま放置された系統が無関係な収束行で
  // 素通りしてしまう）
  {
    name: 'Phase2/外部レビュー対応: 必須系統が未解決（2件）のまま別系統の収束行で最終行を満たす偽装 → 拒否',
    changedFiles: ['docs/README.md'],
    input: {
      loop: rawLoop(
        'Tier: Docs（清掃のみ必須）',
        `| 1 | 清掃 | 2件（未解決） | 未対応 |
| 2 | 敵対的 | 0件 | 収束 |`,
      ),
    },
    expect: 'reject',
    errorIncludes: '直近の実施行が新規所見ゼロ',
  },
  {
    name: 'Phase2/外部レビュー対応: 必須系統を解消後の収束行で再言及 → 受理',
    changedFiles: ['docs/README.md'],
    input: {
      loop: rawLoop(
        'Tier: Docs（清掃のみ必須）',
        `| 1 | 清掃 | 2件（未解決） | 全修正 |
| 2 | 清掃 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
  {
    name: 'Phase2/外部レビュー対応: 1周目に0件で収束済みの系統を後続周で再言及しなくても受理（既定の「所見を出した系統のみ再起動」パターン）',
    changedFiles: ['src/a.js'],
    input: {
      loop: rawLoop(
        'Tier: Light（通常コード変更）',
        `| 1 | 減算 | 0件 | 対象なし |
| 1 | 敵対的 | 2件 | 全修正 |
| 1 | risk-model 検証 | 0件 | 対象なし |
| 1 | コード品質 | 0件 | 対象なし |
| 1 | 清掃 | 0件 | 対象なし |
| 2 | 敵対的 | 0件 | 収束 |`,
      ),
    },
    expect: 'accept',
  },
];

const FAMILIES = [
  { family: '証拠ポインタ / soft claim', cases: evidencePointerCases },
  { family: '区切り記法', cases: delimiterCases },
  { family: '関連 issue 参照', cases: issueRefCases },
  { family: '収束宣言 / 新規所見', cases: convergenceCases },
  { family: '前提列（issue #405）', cases: premiseColumnCases },
  { family: 'Tier 宣言×系統列（issue #452）', cases: tierAngleCases },
];

for (const { family, cases } of FAMILIES) {
  describe(`敵対的スイープ: ${family}`, () => {
    for (const c of cases) {
      test(c.name, () => {
        const changedFiles = c.changedFiles ?? ['src/a.js'];
        const { errors } = checkArtifacts({ changedFiles, body: buildBody(c.input) });
        if (c.expect === 'accept') {
          assert.deepEqual(
            errors,
            [],
            `受理されるべき: ${c.name}\n実際のエラー: ${JSON.stringify(errors)}`,
          );
        } else {
          const subs = Array.isArray(c.errorIncludes) ? c.errorIncludes : [c.errorIncludes];
          assert.ok(
            subs.length > 0 && subs.every((s) => typeof s === 'string'),
            `reject ケースは errorIncludes（string | string[]）を指定してください: ${c.name}`,
          );
          for (const sub of subs) {
            assert.ok(
              errors.some((e) => e.includes(sub)),
              `拒否（"${sub}"）されるべき: ${c.name}\n実際のエラー: ${JSON.stringify(errors)}`,
            );
          }
        }
      });
    }
  });
}
