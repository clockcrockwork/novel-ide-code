# 所見の計上基準（新規所見 / 参考）— 全系統共通

> **Ground truth:** レビューの目的は無限に改善点を探すことではなく、**当初の failure scenario と完了条件が閉じているかを判定する**こと。
> **Consumers:** 全観点レビュアー（各 `angle-*.md` の出力契約から参照）、orchestrator（[subagent-roles.md](../subagent-roles.md) の裁定規則）、収束判定（[pre-commit-review.md](../pre-commit-review.md) ステップ6）。
<!-- agent-commons:generated source=review-angles-finding-criteria version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

所見は次の 2 段に分けて返す。**修正要求になるのは「新規所見」だけ。**

## 新規所見（修正要求。Med 以上）

次のどちらかに当たる欠陥だけを計上する。

- (a) 当初の failure scenario・完了条件・想定ケース表に**直接つながる**欠陥
- (b) **blocker 級** — データ喪失、security boundary の破壊、fail-open、認証・認可の迂回、明確な仕様不一致、merge 後に回復困難な破壊

## 参考（修正要求にしない。Low）

次は「参考」として分け、修正要求にしない。

- 将来 drift の可能性
- parity / machine gate の追加候補
- naming / cleanup
- docs の軽微な重複
- より厳密にできる defensive coding
- issue-candidates へ移せる残余
- 「念のため」の追加 sweep

**「別の仕組みをもっと強くできる」という所見は、現在の失敗様式に直接つながらない限り scope expansion であり参考に分ける。** 参考の送り先は orchestrator が決める（PR 本文「残る制約・判断」に記録するか、[docs/REVIEW_GUIDELINES.md](../../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本) の承認フローを経て `docs/planning/issue-candidates.md` へ）。

## 所見確認モード

所見確認（`findings-check`）では**前回所見の解消確認だけ**を行い、新規探索をしない（差分探索は fresh の 1 回だけ。[README.md](README.md)「review budget」）。確認中に見つけた事項は、上の基準で新規所見に当たる場合だけ計上する。

## 収束との関係

[pre-commit-review.md](../pre-commit-review.md) ステップ6 の「収束 = 再レビューで新規所見ゼロ」の「新規所見」は**本基準の新規所見**を指す（参考は数えない）。
