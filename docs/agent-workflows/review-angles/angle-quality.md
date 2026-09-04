# コード品質レビュー（観点別レビュアー）

> **Ground truth:** [docs/REVIEW_GUIDELINES.md](../../REVIEW_GUIDELINES.md) / [docs/data-model/INVARIANTS.md](../../data-model/INVARIANTS.md) / [docs/ai/rules/repository-conventions.md](../../ai/rules/repository-conventions.md) / 既存コード（同種処理の慣習）
> **Entry gate:** diff が触れる領域の規約（REVIEW_GUIDELINES / INVARIANTS / repository conventions の該当項）と、同種処理の既存実装を特定するまで所見作成に進まない
> **Required artifacts:** 所見一覧（file/line/summary/failure_scenario＋下記分類）
> **Verification gate:** 検出と分類のみ（修正・検証コマンドの実行は担わない）→ [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)
> **Machine boundary:** 規約 / custom rule 違反・閾値の未文書化・依存方向違反 は機械化済みの検出カテゴリ（寄せ先の正本: [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)）。このクラスに当たる指摘を見つけたら、**所見として書いたうえで分類を「machine 化候補」にし、寄せ先が実効していない範囲を名指しする**。**黙って落とさない** — 落とすと、ゲートが実際にはカバーしていない範囲の欠陥が machine からも AI からも見えなくなる。**寄せ先の gate が存在するのに検出できないときは、走査範囲・閾値・設定・CI/hook への配線の有無・exit code を返すかを根拠として添える。添えられないなら machine 化候補にせず、この系統の所見として扱う。寄せ先表に該当する検出カテゴリが無いときは、根拠を求めず「寄せ先の欠落」として machine 化候補にし、どの検出カテゴリが表に無いかを書く。** 正本: [docs/ai/rules/responsibility-boundary.md](../../ai/rules/responsibility-boundary.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「動いているから良い」は品質評価ではない
> **Cost note:** 既存ヘルパーの再実装・規約違反が積もると、同種処理が複数の亜種に分裂し修正が全箇所に届かなくなる
<!-- agent-commons:generated source=angle-quality version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

あなたのアンカーは**規約と既存コード**である。diff が「正しく動くか」ではなく「このリポジトリの書き方に沿っているか・すでにある物を作り直していないか」を問う。

## 問い

- 重複・複雑さ・規約違反・既存ヘルパーの再実装はないか

## 手順

1. diff が触れる領域の規約を特定する（[REVIEW_GUIDELINES.md](../../REVIEW_GUIDELINES.md)・[INVARIANTS.md](../../data-model/INVARIANTS.md)・[repository-conventions.md](../../ai/rules/repository-conventions.md) の該当項）
2. diff の新規関数・util・component について、同種の既存実装を検索する（再実装の検出）
3. 変更部分の周辺コードと比較し、命名・コメント密度・イディオムの乖離を確認する
4. 所見を下記分類で返す

## 所見の分類

| 分類 | 状態 |
|---|---|
| 規約違反 | REVIEW_GUIDELINES / INVARIANTS / repository conventions の明文規則に反する（例: `kindId` 直接比較・`localStorage` 直接操作・動的キー dict の `Object.create(null)` 不使用） |
| 再実装 | 既存ヘルパー・util・component で足りる処理を新造している（既存実装の所在を添える） |
| 重複 | diff 内・diff と既存コードの間で同一ロジックが複数箇所にある |
| 過剰複雑 | 要求に対して不要な抽象化・分岐・状態を持ち込んでいる |
| 慣習乖離 | 動作は正しいが周辺コードの命名・構成・イディオムから外れている |

## 出力契約

所見は [finding-criteria.md](finding-criteria.md) の計上基準に従い「新規所見（修正要求。Med 以上）」と「参考（修正要求にしない。Low）」に分けて返す（同ファイルは全系統共通の正本で、観点の独立性とは無関係のため必ず読む）。

所見1件につき: `file` / `line` / `summary`（1文）/ `failure_scenario`（放置した場合に何が起きるか — 保守時の壊れ方でよい）/ 上記分類のいずれか。

- 検出と分類のみを行い、実装・修正は行わない
- lint・CI で機械検出できる指摘は、所見と併せて lint 化候補として明示する（機械化できるものを人手チェックに残さない）
