# 所見の計上基準（新規所見 / 参考）— 全系統共通

> **Ground truth:** レビューの目的は無限に改善点を探すことではなく、**今回の diff が放置できない欠陥を持ち込んでいないか**を判定すること。「当初計画・当初の failure scenario に無かった」は降格理由ではない — 今回の diff が導入・悪化・新規露出させた現実的な Med 以上の欠陥は、当初の想定外でも Actionable である。
> **Consumers:** 全観点レビュアー（各 `angle-*.md` の出力契約から参照）、orchestrator（[subagent-roles.md](../subagent-roles.md) の裁定規則）、収束判定（[pre-commit-review.md](../pre-commit-review.md) ステップ6）。
<!-- agent-commons:generated source=review-angles-finding-criteria version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

所見は `file` / `line` / `summary` / `failure_scenario`（各 `angle-*.md` が定める系統固有分類を含む）に加え、次の4フィールドで裁定する。**修正要求（Actionable）になるのは下記「Actionable の原則」をすべて満たす所見だけ。**

## 共通 finding fields

### scope_relation

- `introduced`: 今回の diff が新規導入した欠陥
- `worsened`: 既存の問題を今回の diff が悪化させた
- `newly_exposed`: 既存欠陥だが、今回の変更で新しい到達経路・公開面から実害化した
- `pre_existing`: 今回悪化していない既存の問題
- `unrelated`: 今回の変更と無関係

### severity

`blocker` / `high` / `med` / `low`

目安（閉じた定義ではなく判断材料）:

- **blocker**: データ喪失、security boundary の破壊、fail-open、認証・認可の迂回、merge 後に回復困難な破壊
- **high**: 明確な仕様不一致、正当な入力・状態で高頻度に誤動作する欠陥
- **med**: 限定的だが現実的な条件で誤動作する欠陥
- **low**: 将来 drift の可能性、より厳密にできる defensive coding、naming/cleanup、docs の軽微な重複等（単独では Actionable にしない）

### evidence

- `verified`: 実行・再現・明確な静的証拠で成立を確認した
- `strong`: 具体的な入力 → 状態 → 誤結果をコード・正本から追える
- `weak`: 仮説・不足情報が残る

### provenance

- `angle`: 検出した観点（reviewer の machine ID。例: `subtractive` / `riskmodel` / `testquality` 等）
- `anchor class`: その観点が使った ground truth の種類（例: risk table / attack surface / test oracle / spec anchor 等）

## Actionable の原則

原則、次をすべて満たす finding を修正要求候補とする。

```text
scope_relation in {introduced, worsened, newly_exposed}
AND severity >= med
AND evidence in {verified, strong}
```

`pre_existing` / `unrelated` / `low` / `weak` は通常「参考」（Reference / issue candidate 側）へ送る。

**「当初計画に無かった」は Low・参考へ落とす理由にしない。** 今回の diff が導入した現実的な Med 以上の blind spot は、issue・完了条件・想定ケース表に明記されていなくても reviewer が発見すべき対象であり Actionable になりうる。

## machine coverage の扱い

machine detector が定義されているだけで AI finding を黙って落とさない。抑止できるのは、原則 `scope_match`（今回の path / category が走査対象か）∧ `enforcement == enforced` ∧ `executed`（今回実行されたか）∧ `result == pass` の4つが揃う場合だけである。**このメタデータだけを理由に finding を自動削除する実装は現時点では行わない**（structured receipt が安定してから別途評価する）。machine detector の存在と実効 coverage を混同しない — 各 `angle-*.md` の Machine boundary 節が個別の扱いを定める。

## 参考（修正要求にしない。Low 相当）

次は「参考」として分け、原則 Actionable にしない。

- 将来 drift の可能性
- parity / machine gate の追加候補
- naming / cleanup
- docs の軽微な重複
- より厳密にできる defensive coding
- issue-candidates へ移せる残余
- 「念のため」の追加 sweep

**「別の仕組みをもっと強くできる」という所見は、現在の失敗様式に直接つながらない限り scope expansion であり参考に分ける。** 参考の送り先は orchestrator が決める（PR 本文「残る制約・判断」に記録するか、[docs/REVIEW_GUIDELINES.md](../../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本) の承認フローを経て `docs/planning/issue-candidates.md` へ）。

## 所見確認モード

所見確認（`findings-check`）では**前回所見の解消確認だけ**を行い、新規探索をしない（差分探索は fresh の1回だけ。[README.md](README.md)「review budget」）。確認中に見つけた事項は、上の Actionable の原則に当たる場合だけ計上する。

## 収束との関係

[pre-commit-review.md](../pre-commit-review.md) ステップ6 の「収束 = 再レビューで新規所見ゼロ」の「新規所見」は**本基準で Actionable と判定された所見**を指す（参考は数えない）。
