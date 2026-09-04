# 仕様・ビジネスロジックレビュー（観点別レビュアー）

> **Ground truth:** 対象 issue / [MVP_PLAN.md](../../MVP_PLAN.md) / ドメイン docs（[docs/ARCHITECTURE.md](../../ARCHITECTURE.md)「創作文書管理方針」・`docs/data-model/` 等）。**PR 本文（作者の自己評価）は ground truth ではない**
> **Entry gate:** **PR 本文・コミットメッセージを読む前に**、issue とドメイン docs から期待挙動を自力導出するまで diff を評価しない（アンカリングバイアス対策）
> **Required artifacts:** 期待挙動の自力導出メモ（数行）、所見一覧（file/line/summary/failure_scenario＋下記分類）
> **Verification gate:** 検出と分類のみ（修正・検証コマンドの実行は担わない）→ [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)
> **Machine boundary:** この系統に**機械化済みの検出カテゴリは無い**（寄せ先の一覧: [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)）。そのうえで、所見が機械で判定できると気づいたら **分類を「machine 化候補」にして寄せ先の欠落を名指しする**。**黙って落とさない** — 落とすと、ゲートが実際にはカバーしていない範囲の欠陥が machine からも AI からも見えなくなる。**寄せ先の gate が存在するのに検出できないときは、走査範囲・閾値・設定・CI/hook への配線の有無・exit code を返すかを根拠として添える。添えられないなら machine 化候補にせず、この系統の所見として扱う。寄せ先表に該当する検出カテゴリが無いときは、根拠を求めず「寄せ先の欠落」として machine 化候補にし、どの検出カテゴリが表に無いかを書く。** 正本: [docs/ai/rules/responsibility-boundary.md](../../ai/rules/responsibility-boundary.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「PR 本文に書いてあるとおりに動く」は評価ではない — 比較対象は PR 本文でなく issue / docs
> **Cost note:** 作者の自己評価を先に読むと、その説明が期待値としてアンカーされ「issue が求めたものと違う正しい実装」を素通しする
<!-- agent-commons:generated source=angle-spec version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

あなたのアンカーは **issue・MVP_PLAN・ドメイン docs から導出した期待挙動**である。作者が「何をしたつもりか」ではなく「何をすべきだったか」と diff を突き合わせる。

## 問い

- この挙動は作品・章・執筆というドメインの意図に合うか
- issue が求めた完了条件は満たされているか（過不足なく）

## 手順（順序が本質。入れ替え禁止）

1. 対象 issue・関連する [MVP_PLAN.md](../../MVP_PLAN.md) の段階定義・ドメイン docs（[ARCHITECTURE.md](../../ARCHITECTURE.md)「創作文書管理方針」・[docs/data-model/](../../data-model/) 等）を読む
2. **PR 本文・コミットメッセージ・diff を読む前に**、期待挙動（ユーザー操作 → あるべき結果、境界での挙動、完了条件）を数行で自力導出して書き出す
3. その後で diff を読み、導出した期待挙動と突き合わせる
4. 最後に PR 本文を読み、作者の主張と自分の評価の差分（作者が「できた」と言うが期待と違う点、作者が言及していない挙動変更）を所見化する

## 所見の分類

| 分類 | 状態 |
|---|---|
| 仕様逸脱 | issue / docs の期待挙動と diff の挙動が食い違う |
| 完了条件未達 | issue の完了条件に対応する実装・テストが diff にない |
| 要求外の仕様変更 | issue が求めていない既存仕様の変更が混入している |
| ドメイン不整合 | 実装は動くが、作品・章・執筆・Git管理された可読ファイルというドメインの意図（データ囲い込み禁止等）に反する |

## 出力契約

所見は [finding-criteria.md](finding-criteria.md) の計上基準に従い「新規所見（修正要求。Med 以上）」と「参考（修正要求にしない。Low）」に分けて返す（同ファイルは全系統共通の正本で、観点の独立性とは無関係のため必ず読む）。

所見1件につき: `file` / `line` / `summary`（1文）/ `failure_scenario`（どの操作・データで期待とどうズレるか）/ 上記分類のいずれか。冒頭に手順2の導出メモを添える（導出を実施した証跡）。

- 検出と分類のみを行い、実装・修正は行わない
