# 実装前の既存実装調査（codebase-recon）

> **Ground truth:** 現行コードベース（Grep / Glob の実行結果）/ [docs/ARCHITECTURE.md](../ARCHITECTURE.md) / [docs/data-model/INVARIANTS.md](../data-model/INVARIANTS.md) / 過去レビュー指摘（`docs/pr/PR-*.md`）
> **Entry gate:** 必須検索セット（手順2）を実行し、調査表（手順3）に再利用 / 準拠 / 新規の判断を記録するまでコードを書き始めない
> **Required artifacts:** 既存実装調査表（実行した検索クエリ・ヒット・判断＋理由・新規作成の正当化）。実装計画・作業メモ・PR本文に残す
> **Verification gate:** `npm run check:artifacts`（コード変更 PR は「既存実装調査」セクションの存在・非空を機械検証）→ [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)。事後検出は `npm run analyze:duplicates` / `npm run analyze:unused`
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。追加禁止事由: 「新規ファイルなので既存調査不要」「issue に実装方針が書いてあるので不要」「このコードベースは把握しているので検索不要」
> **Cost note:** 省略すると、既存 util の再発明・慣習に沿わない実装・呼び出し側の破壊が混入し、jscpd / knip / レビューでの後追い指摘と手戻りが発生する

実装（コードの1行目）を書き始める前に、**現行コードベースを検索して**類似実装・再利用候補・慣習サンプル・影響箇所を洗い出し、「再利用するか・慣習に従うか・新規に作るか」を理由付きで確定する工程。

高能力モデルが自然に行う「書く前に grep して既存と比較する」動きを、担当モデルの能力・気質に依存しない**成果物駆動の工程**として固定することが目的。実装エージェント（Claude Sonnet / Codex / Gemini 等）が誰であっても、この調査表を作らずにコードを書き始めることはできない。

## 原則

- **検索してから書く。書いてから探さない。** 実装後の重複発見はレビュー差し戻しになる。
- **「見つからなかった」も成果**。新規作成は「探して無かった」という検索記録付きでのみ正当化される。探さずに作らない。
- **慣習は最も近い既存ファイルから写す**。ただし既存コードが正しいとは限らない（anti-skip「既存に合わせたので確認不要」参照）。既存の書き方が正本 docs（[ARCHITECTURE.md](../ARCHITECTURE.md) / [INVARIANTS.md](../data-model/INVARIANTS.md)）と矛盾する場合は docs を優先し、矛盾の存在を PR 本文・issue に記録する。
- **実装中に対象が増えたら再実行**。実装途中で新しい関数・ファイル・依存を作ると決めた時点で、その対象について手順2を再実行し調査表に追記する。

## 呼び出しタイミング

- 標準フロー（[subagent-roles.md](subagent-roles.md)）では requirement-probe → risk-modeling の**後、実装の直前**。risk-modeling と同一セッションでよい。
- pick-issue を経由しない作業でも、コードに触れる変更では実装着手前に必須。
- **plan モード**: コード変更を含む計画は、plan 本文に既存実装調査表を埋めるか `/codebase-recon` の実行を実装前工程として明記する。ExitPlanMode 時に `scripts/agent/hooks/check-plan-gates.js` が機械検査する（fail-open。最終防衛線は PR 段階の `artifacts-gate`）。
- orchestrator が implementer に実装を移譲する場合、この調査表を requirement-probe / risk-modeling の成果物と併せて入力として渡す。

## 手順

### 1. 検索語の導出

issue 本文・実装計画から機能の名詞・動詞を抜き出し、検索語リストを作る。

- 日本語 / 英語の両方（UI 文言は日本語、識別子は英語で書かれている）
- 同義語・略語（例: 「保存」→ save / persist / flush / write）
- 既存の命名規則からの推測（`use*` hooks / `*Store` / `*Mod.jsx` / `*Modal.jsx` / `*Extension` 等）

### 2. 必須検索セット

以下 5 カテゴリを**最低 1 クエリずつ実行**し、実際に実行したクエリを記録する（**結果ゼロでも記録する**。「探して無かった」が新規作成の根拠になる）。

| カテゴリ | 目的 | 検索の例 |
|---|---|---|
| **a. 同一・類似機能** | 既に存在するものを再発明しない | 機能名・UI 文言・関連語で `src/` / `worker/src/` を Grep |
| **b. 再利用候補** | 使える共通部品を先に見つける | `src/lib/` / `src/hooks/` / `src/stores/` / `src/components/common/` を対象に部品名・処理名で検索 |
| **c. 慣習サンプル** | 同種ファイルの書かれ方に合わせる | 同種の既存ファイルを `Glob`（例: `**/*Mod.jsx` / `src/stores/*.js`）で列挙し、最低 1 つを `Read` で**全文読む**（新しい Mod なら既存 `*Mod.jsx`、新しい store なら既存 `src/stores/*.js`） |
| **d. 影響箇所** | 変更するシンボルの呼び出し側を漏らさない | 変更する関数・store・コンポーネント名でリポジトリ全体を Grep |
| **e. 過去の経緯** | 同領域の過去指摘・不変条件を踏まえる | `docs/pr/PR-*.md` / [INVARIANTS.md](../data-model/INVARIANTS.md) / 関連 issue を対象領域のキーワードで引く |

### 3. 既存実装調査表の作成

以下のテンプレートを実装計画（PR 本文または作業メモ）に埋める。

```md
## 既存実装調査

| # | 目的 | 検索クエリ / 参照先 | 結果（file:line / なし） | 判断 | 理由 |
|---|---|---|---|---|---|
| 1 | 類似機能 | `Grep "スナップショット" src/` | src/lib/snapshots.js:42 | 再利用 | 保存系は既存 API に寄せる |
| 2 | 慣習 | src/components/sidebar/PomodoroMod.jsx 全読 | ― | 準拠 | Mod 構造・ModuleWrapper 慣習に従う |
| 3 | 影響箇所 | `Grep "saveSnapshot"` | 呼び出し側 3 箇所 | 影響あり | 変更対象ファイル一覧に反映 |

### 新規作成するもの
- {ファイル / 関数} — 既存に無いことを確認した検索: #{n}。既存 {候補} を使わない理由: {...}
- （新規作成なしの場合は「なし」と明記）
```

「判断」の値: **再利用**（既存をそのまま使う）/ **拡張**（既存に手を入れて使う）/ **準拠**（書き方の手本にする）/ **新規**（探して無かったので作る）/ **影響あり**（呼び出し側の修正が必要）。

### 4. 判断ルール

- 類似実装が見つかった場合、**再利用または拡張を第一候補**とする。類似実装と並存する新規実装を作る場合は、並存させる理由を表に残す。
- 慣習サンプル（c）と異なる書き方を選ぶ場合は、その理由を表に残す（黙って逸脱しない）。
- 影響箇所（d）でヒットした呼び出し側は、[implementation.md](../ai/rules/implementation.md) の「変更対象ファイルと影響範囲の一覧」に反映する。
- 判断に迷う場合（大きな重複の解消・既存 API の破壊的変更が必要になる等）は、実装で解決せず orchestrator / ユーザーに差し戻す（提供結果の範囲を勝手に広げない。[REVIEW_GUIDELINES「PR の単位」](../REVIEW_GUIDELINES.md#pr-の単位正本)）。

### 5. 引き継ぎ

調査表を実装計画・PR 本文に残し、実装（implementer）へ渡す。PR 本文の「既存実装調査」セクションは、コード変更 PR で `npm run check:artifacts`（CI: `artifacts-gate`）が存在・非空を機械検証する。

## 機械化との関係

`npm run analyze:duplicates`（jscpd）と `npm run analyze:unused`（knip）は**書いた後**にしか検出できない事後ゲート。本工程はその手前の予防であり、両者は排他ではなく併用する（[verification-gates.md](../ai/rules/verification-gates.md)「機械的検出」）。

将来の機械化候補（実装は本ワークフローの範囲外）: 変更予定ファイル一覧から慣習サンプル・関連 PR 履歴・再利用候補ディレクトリを自動提示する `scripts/agent/` 拡張（subagent-roles.md の導入段階「コスト削減」と同期）。

## 関連

- [docs/agent-workflows/subagent-roles.md](subagent-roles.md) — ロール定義・標準フロー（本工程は risk-modeling と実装の間）
- [docs/ai/rules/implementation.md](../ai/rules/implementation.md) — implementer の必須 artifact（既存実装調査表を含む）
- [docs/agent-workflows/risk-modeling.md](risk-modeling.md) — 前工程（異常系・外部状態変化の洗い出し）
- [docs/agent-workflows/evidence-check.md](evidence-check.md) — 機械的下限ゲート（`npm run check:artifacts`）の正本
- [docs/maintenance/code-cleanup.md](../maintenance/code-cleanup.md) — 調査で見つけた既存の重複・負債を「ついで修正」せず issue 候補として承認フローへ回す判断基準
