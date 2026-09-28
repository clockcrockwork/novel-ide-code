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
  // Phase 5 §15.4 authority switch で registry 登録した canonical normal angle。
  // **legacy `TIER_ANGLES`（Full 等）へは追加しない** — 「Full = ANGLE_TOKENS 全キー」の旧不変
  // 条件は本 PR で明示的に撤去した（正本: docs/planning/review-system-phase5-plan.md §15.4）。
  // launch 可否（ANGLE_TRIGGERS / ANGLE_EXEC_BASELINE / `.claude/agents/review-testquality.md`）は
  // 別途 authority routing（review-plan.js の semantic selectedAngles）でのみ到達する。
  testquality: { label: 'test-quality', accept: ['test-quality', 'testquality'] },
};

// 条件起動系統。ANGLE_TOKENS と分離する理由は「Full = ANGLE_TOKENS 全キー」の維持ではない
// （その不変条件は testquality 登録により本 PR で撤去済み）。分離する理由は種別そのものが違う
// ことにある: 条件起動系統は semantic routing の通常 selectedAngles とは独立した既存条件
// （accepted memory hit 等）で加算する `conditionalAngles` であり、
// `escalate --angles <normal-id>` の対象になる通常 angle ではない
// （正本: docs/planning/review-system-phase5-plan.md §4.1）。
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
//
// **`legacyReviewContract`（pre-switch selection policy）の一部として凍結済み。**
// Phase 5 §15.4 authority switch 後も、ここは switch 前の Tier マッピングのまま変更しない
// （fallback 時に current snapshot へ適用する凍結 policy の構成要素。正本:
// docs/planning/review-system-phase5-plan.md §3.5-9, §15.4）。**`Full` は意図的に7キーの
// リテラルのまま** — `testquality` は ANGLE_TOKENS 登録後も追加しない。「Full = 全 ANGLE_TOKENS
// key」の旧不変条件と、新規 canonical normal angle の registry 登録は独立した決定である
// （後者をしても前者へ自動昇格しない。`escalateAngles`/`reclassifyTier` が呼ぶ
// `widenEffectiveTier` も同じ理由で testquality を Tier 名解決の対象から除外する）。
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

/**
 * `state.escalations` のうち `kind === 'manual-escalation'` が指す通常 angle target の集合。
 *
 * **review-plan.js（`deriveEscalatedAngles`）と shadow-routing.js（`deriveShadowEscalatedAngles`）
 * が共有する唯一の実装。** どちらも `state`（プレーンオブジェクト）と本ファイルの `ANGLE_TOKENS`
 * だけに依存し、互いに固有のシンボルへは依存しないため、この依存フリーなファイルへ置くことで
 * review-plan.js ⇄ shadow-routing.js の循環 import を作らずに重複を解消できる（減算レビュー所見）。
 *
 * `kind === 'tier-reclassification'`（legacy Tier 自動再検証）と、両 kind を無差別に蓄積する
 * `state.addedAngles` はここでは一切参照しない（正本: review-system-phase5-plan.md §4.1/§4.2/
 * §9/§15.4）。`memory` は conditional kind のまま維持するため除外する。
 */
export function deriveEscalatedAngles(state) {
  const targets = new Set();
  for (const e of state.escalations ?? []) {
    if (e.kind !== 'manual-escalation') continue;
    if (!Array.isArray(e.angles)) continue;
    for (const a of e.angles) {
      if (a === 'memory') continue;
      if (typeof a !== 'string' || !Object.hasOwn(ANGLE_TOKENS, a)) continue;
      targets.add(a);
    }
  }
  return [...targets];
}

// authority routing の selectedSidecars が取りうる閉じた語彙。現時点で plan（§4.2 routing table）
// が定義する sidecar は `/security-review` のみ。resolveRoutingAuthority（review-plan.js）が
// selection.selectedSidecars をこの語彙で検証する（敵対的レビュー所見 F3: 閉じた語彙外の任意
// 文字列が formatPlan の起動指示行へ素通りしていた）。
export const KNOWN_SIDECARS = ['/security-review'];

// authority routing execution receipt（#645「head-bound execution-plan receipt」。契約の正本は
// Phase 5 §3.5 のrouting assessment契約・§15.4のauthority switch）。
// PR 本文へ機械可読な形で埋め込む閉じた1行文法のラベル・バージョン。
// **review-plan.js（生成・正本）と check-artifacts.js（検証・consumer）が共有する唯一の定義**
// （`deriveEscalatedAngles`/`deriveMemoryConditional` と同じ「依存フリーな leaf module に置いて
// 重複を防ぐ」理由）。receipt は semantic assessment 全文の恒久化ではなく、review-plan.js の
// `buildPlan()` が確定した **actual execution obligation**（`effectiveAngles` 等）を
// 現在の PR head SHA に束縛した derived execution record として PR 本文へ運ぶためのものである
// （正本: docs/planning/review-system-phase5-plan.md §3.5, §15.4）。
export const AUTHORITY_RECEIPT_LABEL = 'Authority receipt';
export const AUTHORITY_RECEIPT_VERSION = 1;

// receipt の angle 一覧フィールド（selected/escalated/conditional/effective/sidecars）の
// 空集合表現。生成側（formatAngleList）と検証側（parseAngleList）が同じ規約を共有することで、
// 「空をどう表すか」がどちらか一方だけ変わって不一致になるのを防ぐ。
const EMPTY_ANGLE_LIST = '-';

export function formatAngleList(tokens) {
  return tokens.length > 0 ? tokens.join(',') : EMPTY_ANGLE_LIST;
}

// receipt の1フィールド分の文字列をトークン配列へ戻す。空集合表現（`-`）は `[]` にする。
// 閉じた語彙かどうかはここでは判定しない（呼び出し側が ANGLE_TOKENS 等の hasOwn 検証を行う）。
export function parseAngleList(text) {
  return text === EMPTY_ANGLE_LIST ? [] : text.split(',');
}

/**
 * memory の conditional 判定。`--memory-hits > 0` / `state.memoryRequired` に加え、
 * `state.escalations` の `kind === 'manual-escalation'` で `memory` が対象になっている場合も
 * conditional とする。
 *
 * **review-plan.js（`buildPlan` の `memoryRequired`）と shadow-routing.js
 * （`deriveShadowMemoryConditional`）が共有する唯一の実装**（`deriveEscalatedAngles` と同じ理由
 * でこのファイルへ置く）。`escalateAngles(['memory'])` は `memory` を通常 angle へ型変換せず
 * conditional kind のまま維持するため（`deriveEscalatedAngles` が明示的に除外する）、
 * `state.memoryRequired` を自動では立てない。authority mode の `effectiveAngles` は
 * `selectedAngles ∪ escalatedAngles` だけで決まり `state.addedAngles` を参照しないため、
 * この escalation 経路を別途見ないと「hit 無しで `escalate --angles memory` した attempt」で
 * memory レビュー義務が authority mode でだけ消える（spec レビュー所見: 実行確認済みの回帰）。
 */
export function deriveMemoryConditional(state, memoryHits = 0) {
  if (memoryHits > 0 || state.memoryRequired === true) return true;
  for (const e of state.escalations ?? []) {
    if (e.kind === 'manual-escalation' && Array.isArray(e.angles) && e.angles.includes('memory')) {
      return true;
    }
  }
  return false;
}
