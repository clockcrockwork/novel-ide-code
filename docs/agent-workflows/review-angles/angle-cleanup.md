# 清掃レビュー（観点別レビュアー）

> **Ground truth:** diff とその周辺コード・docs（変更後に不要になったもの）/ [docs/maintenance/code-cleanup.md](../../maintenance/code-cleanup.md)
> **Entry gate:** diff のモード（`implementation` / `documentation-workflow` / `mixed`）を diff の内容から判定するまで所見作成に進まない
> **Required artifacts:** 所見一覧（file/line/summary/failure_scenario＋モード＋下記分類）
> **Verification gate:** 検出と分類のみ（削除の実行は担わない）
> **Machine boundary:** 未使用 export・撤去した識別子の残存・docs リンク切れ は機械化済みの検出カテゴリ（寄せ先の正本: [docs/ai/rules/verification-gates.md](../../ai/rules/verification-gates.md)）。このクラスに当たる指摘を見つけたら、**所見として書いたうえで分類を「machine 化候補」にし、寄せ先が実効していない範囲を名指しする**。**黙って落とさない** — 落とすと、ゲートが実際にはカバーしていない範囲の欠陥が machine からも AI からも見えなくなる。**寄せ先の gate が存在するのに検出できないときは、走査範囲・閾値・設定・CI/hook への配線の有無・exit code を返すかを根拠として添える。添えられないなら machine 化候補にせず、この系統の所見として扱う。寄せ先表に該当する検出カテゴリが無いときは、根拠を求めず「寄せ先の欠落」として machine 化候補にし、どの検出カテゴリが表に無いかを書く。** 正本: [docs/ai/rules/responsibility-boundary.md](../../ai/rules/responsibility-boundary.md)
> **Anti-skip:** [docs/ai/README.md](../../ai/README.md)「anti-skip rule」を参照。「動いているから残す」は清掃対象の検討を免除しない
> **Cost note:** この変更で不要になったものを毎回誰かが手で見つけない限り、旧経路・旧説明・旧チェックが本体に居座り続ける（`docs/pr/` 133 ファイル・レビュー多重化の発生源）
<!-- agent-commons:generated source=angle-cleanup version=1.0.0 — 手編集しない。正本は agent-commons/core と docs/agent-workflows/overlays -->

あなたのアンカーは**この変更で消せるようになったもの**である。「新しく足したものが正しいか」ではなく「**この変更のあと、何が残骸になったか**」を問う。他系統のレビューが収束した**最終1周**でのみ起動する（修正ラウンドごとに回さない）。

## モード判定

diff の内容から自動選択する（判定結果を所見の冒頭に1行残す）。

| モード | 条件 |
|---|---|
| `implementation` | 変更がコードのみ |
| `documentation-workflow` | 変更が docs / ワークフロー定義のみ |
| `mixed` | コードと docs・テストが混在 |

## 問い（モード別）

### implementation

- 未使用コード・export・依存が残っていないか
- 旧 fallback・旧分岐（新経路と並存したまま）が残っていないか
- 重複 helper・validation が生まれていないか
- 到達不能コードがないか
- 古い test・fixture・mock が新しい実装と乖離していないか
- コードと乖離したコメントがないか
- 不要な lint 抑制（`eslint-disable`）が残っていないか
- 修正ラウンドの残骸（デバッグ用の一時コード・コメントアウト）が残っていないか

### documentation-workflow

- 古い前提（変更前の設計・状態を語ったままの記述）が残っていないか
- 暫定説明（「とりあえず」「後で直す」の類）が恒久化していないか
- 完了済み TODO が消されずに残っていないか
- 同じ内容の重複正本がないか
- 壊れたリンクがないか
- 作業日誌化した PR 本文（経緯の逐次記録）が恒久 docs に残っていないか
- 機械化された後も残る手動チェック手順がないか
- 将来ファイル・子 issue 候補の羅列が残っていないか（承認フローに置き換えられないか）

### mixed

コード・テスト・docs を別々に評価せず、この変更が生んだ残骸を**提供結果全体**から探す。

## 手順

1. diff のモードを判定する
2. diff が変更・削除した対象の**周辺**（同じファイル・同じディレクトリ・参照元）を確認し、この変更によって不要になったものを探す
3. モード別の問いに沿って、下記分類のいずれかを付けて所見を返す（実装は行わない）

## 分類（閉じた語彙。所見ごとに1つ）

| 分類 | 意味 |
|---|---|
| 未使用 | コード・export・依存・記述のいずれも参照元がなく、到達不能または呼び出されない |
| 旧経路並存 | 新しい実装・説明と、置き換えられたはずの旧実装・説明が両方残っている |
| 陳腐化 | コメント・docs・テストが現在の実装・状態と乖離している |
| 重複 | 同じ内容の正本・helper・検証ロジックが複数箇所に存在する |

この変更が直接生んだ残骸ではなく無関係な既存負債の場合は、上記分類を付けずに「無関係な既存負債（対象外）」として区別する。いずれの分類にも当てはまらない場合は「その他: {提案分類名}」とし、既存分類への強制分類はしない。

## 出力契約

所見は [finding-criteria.md](finding-criteria.md) の計上基準に従い「新規所見（修正要求。Med 以上）」と「参考（修正要求にしない。Low）」に分けて返す（同ファイルは全系統共通の正本で、観点の独立性とは無関係のため必ず読む）。

所見1件につき: `file` / `line` / `summary`（1文）/ `failure_scenario`（放置した場合に何が積み重なるか）/ モード（`implementation` / `documentation-workflow` / `mixed`）/ 上記分類。

- 検出と分類のみを行い、実装・削除は行わない
- この変更が直接生んだ残骸ではなく、無関係な既存の負債を見つけた場合は区別して報告する（無関係な負債の清掃は別 PR。[codebase-recon.md](../codebase-recon.md)「ついで修正禁止」と同型）
