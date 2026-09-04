// レビューループ記録「系統」セルの受理トークン（閉じた文法）と Tier 別必須系統（#452・Phase 2）。
// prose 側の正本: docs/agent-workflows/review-angles/README.md「7系統の定義」「収束と記録」。
// README との drift は tests/reviewAngleTokens.test.js が機械検出する。
// classify-changes.js と同じく依存フリーを維持する（CI から npm ci なしで参照できるように）。

// accept は「系統セルでこの系統の実施記録とみなす表記」の閉じたリスト（短縮形＋README 系統表の正式名）。
// 自由記述（`riskmodel 再照合 (self)` 等）は意図的に不受理 — 系統の起動証跡は閉じた語彙でのみ数える
export const ANGLE_TOKENS = {
  subtractive: { label: '減算', accept: ['減算', '減算レビュー'] },
  riskmodel: { label: 'risk-model 検証', accept: ['risk-model 検証', 'risk-model'] },
  spec: { label: '仕様・ビジネスロジック', accept: ['仕様・ビジネスロジック', '仕様'] },
  adversarial: { label: '敵対的', accept: ['敵対的'] },
  quality: { label: 'コード品質', accept: ['コード品質', '品質'] },
  operability: { label: '運用性・状態遷移', accept: ['運用性・状態遷移', '運用性'] },
  cleanup: { label: '清掃', accept: ['清掃', '清掃レビュー'] },
};

// 条件起動系統（ANGLE_TOKENS に加えない理由: Full = ANGLE_TOKENS 全キーの不変条件を維持するため）。
// 正本: docs/agent-workflows/review-angles/README.md「条件起動系統」
export const CONDITIONAL_ANGLE_TOKENS = {
  memory: { label: '記憶適合', accept: ['記憶適合', '記憶適合レビュー'] },
};

// 実行可能設計文書に触れる変更で、コード変更（Full/Light）に加算する系統（#452）。
// 減算・清掃は Full/Light の基礎系統に既に含まれるため、加算分には含めない
// （コード＋設計文書混在では基礎 Tier の減算・清掃で足りる。Phase 2 §3）
export const DESIGN_ADDON_ANGLES = ['spec', 'operability'];

// 基礎 Tier 宣言名 → 必須系統。設計文書の加算（designDocsChanged）は check-artifacts 側で
// DESIGN_ADDON_ANGLES を合成する（宣言名「{基礎 Tier}＋設計文書」に対応）。
// 設計文書 / Record / Docs は docs のみ PR の**独立した基礎 Tier**としても使う値
// （この場合は DESIGN_ADDON_ANGLES と異なり、減算・清掃を含む — 加算専用の
// DESIGN_ADDON_ANGLES とは目的が異なるため意図的に値を分けている）
export const TIER_ANGLES = {
  Full: ['subtractive', 'riskmodel', 'spec', 'adversarial', 'quality', 'operability', 'cleanup'],
  Light: ['subtractive', 'riskmodel', 'adversarial', 'quality', 'cleanup'],
  設計文書: ['subtractive', 'spec', 'operability', 'cleanup'],
  Record: ['subtractive', 'cleanup'],
  Docs: ['cleanup'],
};

// 基礎 Tier 名（コード変更のリスクで判定する側）。check-artifacts の base 判定・宣言名の
// 生成はここから導出する（Full/Light のハードコード禁止 — 新基礎 Tier 追加時は本配列と
// TIER_ANGLES・README を更新すれば gate 側は追従する）
export const BASE_TIER_NAMES = ['Full', 'Light'];

// docs のみ PR で使う非基礎 Tier（コードと混在しない。「{基礎}＋設計文書」の加算とは別物）。
// 判定の優先順（check-artifacts の mandate 解決順）: 設計文書 > Record > Docs
export const DOCS_ONLY_TIER_NAMES = ['設計文書', 'Record', 'Docs'];

// Tier 宣言行の宣言名（閉じた語彙）。長い名を先に置く（正規表現の選択肢順を保つ）。
// check-artifacts の TIER_DECL 正規表現・エラーメッセージはここから生成する（複製禁止）。
// 新 Tier 追加時の更新対象: BASE_TIER_NAMES（基礎）または DOCS_ONLY_TIER_NAMES（非基礎）・
// TIER_ANGLES・README「収束と記録」＋ Tier 表・tests/reviewAngleTokens.test.js（drift 検査が README との
// 一致を機械検証する）
export const TIER_DECL_NAMES = [
  ...BASE_TIER_NAMES.map((b) => `${b}＋設計文書`),
  ...BASE_TIER_NAMES,
  ...DOCS_ONLY_TIER_NAMES,
  'なし',
];
