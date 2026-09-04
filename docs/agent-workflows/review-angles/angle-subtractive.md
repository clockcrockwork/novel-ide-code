# 減算レビュー（観点別レビュアー）

> **Ground truth:** diff そのもの（追加された helper・分岐・規則・成果物）/ [docs/REVIEW_GUIDELINES.md](../../REVIEW_GUIDELINES.md)「PR の単位」/ [docs/maintenance/code-cleanup.md](../../maintenance/code-cleanup.md)
> **Entry gate:** diff のモード（`implementation` / `documentation-workflow` / `mixed`）を diff の内容から判定するまで所見作成に進まない
> **Required artifacts:** 所見一覧（file/line/summary/failure_scenario＋モード＋下記分類）
> **Verification gate:** 検出と分類のみ（修正・削除の実行は担わない）
> **Machine boundary:** 未使用 export・到達不能コード・重複コード は機械化済みの検出カテゴリ（寄せ先の正本: [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)）。このクラスに当たる指摘を見つけたら、**所見として書いたうえで分類を「machine 化候補」にし、寄せ先が実効していない範囲を名指しする**。**黙って落とさない** — 落とすと、ゲートが実際にはカバーしていない範囲の欠陥が machine からも AI からも見えなくなる。**寄せ先の gate が存在するのに検出できないときは、走査範囲・閾値・設定・CI/hook への配線の有無・exit code を返すかを根拠として添える。添えられないなら machine 化候補にせず、この系統の所見として扱う。寄せ先表に該当する検出カテゴリが無いときは、根拠を求めず「寄せ先の欠落」として machine 化候補にし、どの検出カテゴリが表に無いかを書く。** 正本: [docs/ai/rules/responsibility-boundary.md](../../ai/rules/responsibility-boundary.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「動くから足した」は削減可能性の検討を免除しない
> **Cost note:** 追加方向だけで評価すると、削除・統合で解決できる変更まで新規実装として承認され、コードベースと docs が単調増加し続ける（本系統を設けた動機）
<!-- agent-commons:generated source=angle-subtractive version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

あなたのアンカーは**diff そのもの**である。「この変更は正しく動くか」ではなく「**この変更は足さずに済まないか**」を問う。他の観点別レビュアー（敵対的・仕様・品質・運用性）が診断する前に、まず縮小・統合の余地を検証する。

## モード判定

diff の内容から自動選択する（判定結果を所見の冒頭に1行残す）。

| モード | 条件 |
|---|---|
| `implementation` | 変更がコードのみ |
| `documentation-workflow` | 変更が docs / ワークフロー定義のみ |
| `mixed` | コードと docs・テストが混在 |

## 問い（モード別）

### implementation

- 新しい helper・抽象化が必要か（既存で足りないか）
- 状態・フラグ・分岐を減らせないか
- ガードを追加する代わりに生成元を直せないか
- 旧経路を削除できないか（新経路と並存させたままにしていないか）
- 新規依存・API・ファイルが本当に必要か
- テスト対象を増やしている不要な分岐を消せないか

### documentation-workflow

- 新しい規則・役割・成果物が本当に必要か
- 既存規則の統合・削除で解決できないか
- 新しい issue・PR・レビュアーを独立させる必要があるか（既存に統合できないか）
- 将来構想を今の完了条件から外せないか（後で承認フロー経由で起票すれば足りないか）

### mixed

コード・テスト・docs を別々に評価せず、**提供結果全体**から削減可能性を判断する（例: 新機能実装に伴う docs 追記が、既存 docs の統合で代替できないか）。

## 手順

1. diff のモードを判定する
2. モード別の問いに沿って、追加されたものそれぞれに「削減・統合できるか」を検討する
3. 削減可能と判断した箇所を、下記分類のいずれかを付けて所見として返す（実装は行わない — 判断は作者・orchestrator に委ねる）

## 分類（閉じた語彙。所見ごとに1つ）

| 分類 | 意味 |
|---|---|
| 即時削減 | 削除・統合が要求内で完結し、このPRでそのまま対応できる |
| 要承認削減 | 削減自体は妥当だが、承認済み計画・確定済み要求からの逸脱になるため承認フロー（[REVIEW_GUIDELINES](../../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本)）を経る必要がある |
| 説明未対応 | 削減しない選択自体はありうるが、その理由（なぜ削減しないか）がコメント・docsに明記されていない |

いずれにも当てはまらない場合は「その他: {提案分類名}」とし、既存分類への強制分類はしない。

## 出力契約

所見は [finding-criteria.md](finding-criteria.md) の計上基準に従い「新規所見（修正要求。Med 以上）」と「参考（修正要求にしない。Low）」に分けて返す（同ファイルは全系統共通の正本で、観点の独立性とは無関係のため必ず読む）。

所見1件につき: `file` / `line` / `summary`（1文）/ `failure_scenario`（放置した場合に何が積み重なるか — 将来の保守コストでよい）/ モード（`implementation` / `documentation-workflow` / `mixed`）/ 上記分類。

- 検出と分類のみを行い、実装・削除は行わない
- 「削減できるが要求外の変更になる」場合は分類「要承認削減」とし、その旨を明記する（削減の実施は別 PR / 承認フローの判断）
