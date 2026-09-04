# 対応issueの選定

> **Ground truth:** [docs/MVP_PLAN.md](../MVP_PLAN.md)（段階定義の正）/ オープンissue・PR一覧 / `docs/pr/` 最新記録 / [docs/FUTURE_MAP.md](../FUTURE_MAP.md)（補助）
> **Entry gate:** issue・PR・依存関係・MVP段階を収集・判定するまで推奨を提示しない
> **Required artifacts:** 優先度順の一覧表、依存解決状況、選定後の想定ケース洗い出し（[risk-modeling.md](risk-modeling.md)）
> **Verification gate:** 推奨理由の明示とユーザー承認。実装系の検証は選定後の各ワークフローへ → [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。MVP段階・依存・対応中ステータスの確認を飛ばさない
> **Cost note:** 省略すると重複着手・優先度逆転・依存未解決issueへの着手が起こる

issue と PR を自動収集・関連付け・優先度付けし、推奨issueをユーザーに提示して対応issueを決定する。

重複対応・優先度の逆転・すでに対応中のissueへの再着手を防ぐことが目的。

## 手順

### 1. データ収集（並列）

以下を並列で取得する：

- **オープンissue 一覧**（番号・タイトル・ラベル・担当者・作成日）
- **オープンPR 一覧**（番号・タイトル・ブランチ名・本文・状態）
- **`docs/pr/` の最新5件**（直近で完了した作業の把握）
- **`docs/MVP_PLAN.md`**（MVP 段階定義の正。現在の運用テストは MVP Alpha。**Alpha 対象外の機能を推奨しない**）
- **`docs/FUTURE_MAP.md`**（旧 ROADMAP.md。将来構想・候補機能の一覧。**実装優先順位として読まない**）

エージェント別の取得方法：
- **Claude**：GitHub MCP tools（`list_issues`, `list_pull_requests`）を使用。issue本文（body）も取得対象に含める
- **Codex / Gemini / human**：`bash scripts/gh/list-issues-prs.sh` を使用（出力JSONに `body` フィールドを含む）

### 2. 関連付け・ステータス判定

各issueに対して以下の判定を行う：

| 状態 | 判定条件 | マーク |
|------|---------|--------|
| 対応中 | オープンPRのブランチ名 or 本文に `#issue番号` が含まれる | 🔄 対応中 |
| 完了済み | `docs/pr/` にPR記録があり、かつPRがマージ済み（issueがまだopenの場合は注記） | ✅ 完了 |
| 未着手 | 上記以外 | 📋 未着手 |

### 2.5. 依存関係の解析

各オープンissueの本文から `## 関連 issue / PR` セクションを解析し、依存関係を抽出する。

解析対象のパターン：
- `depends: #N` — このissueは #N が完了するまで着手不可
- `blocks: #N` — このissueが完了すると #N が着手可能になる

各issueの depends_on リストに含まれる番号を確認する：

| 依存先issueの状態 | 判定 |
|-----------------|------|
| closed、または `docs/pr/` で完了確認済み | 依存解決済み（着手可） |
| open かつ未完了 | 🚫 依存未解決（着手不可） |

依存フィールドがないissue、またはセクションが空のissueは「依存なし」として扱う。

### 3. 優先度スコアリング

**MVP 期間中は [docs/MVP_PLAN.md](../MVP_PLAN.md) の段階定義を最優先する。** 現在の運用テストは MVP Alpha のため、Alpha 保証範囲の Issue を最上位に置き、Alpha 対象外（辞書・校正・通知・フロータイム・外部連携等）は段階が来るまで推奨しない。FUTURE_MAP.md の掲載順・ラベル・作成日は補助的に使う。

優先度マトリクス：

| 優先度 | 条件 |
|--------|------|
| P0 | `bug` ラベル / **現在の MVP 段階（Alpha）の保証範囲**（MVP_PLAN.md） |
| P1 | FUTURE_MAP に記載のある機能・パフォーマンス課題（ただし現在の MVP 段階に属するもの優先） |
| P2 | その他 `feat` / `enhancement` |
| P3 | `chore` / `docs` / `refactor` |

同一優先度内では FUTURE_MAP の掲載順 → issue番号の昇順で並べる。MVP 段階が後（Beta/Gamma/Delta/future）の Issue は、現段階の候補を出し切ってから提示する。

### 4. 推奨issue決定・提示

全issueを優先度順に並べた表を出力する：

```
| # | タイトル | 優先度 | ステータス | 依存 | 関連PR | MVP段階 |
|---|---------|--------|----------|------|--------|---------|
| #218 | GitHub未接続退避モード | P0 | 📋 未着手 | - | - | alpha |
| #53 | モバイル・PWA・IME対応 | P0 | 📋 未着手 | - | - | alpha(subset) |
| #171 | 新機能A | P0 | 🚫 依存未解決 | #145 | - | alpha |
| #95 | 校正・品質チェック | P1 | 📋 未着手 | - | - | beta/gamma |
| ... |
```

ステータスの凡例：
- `📋 未着手` — 依存解決済み、着手可能
- `🔄 対応中` — すでに対応中のPRがある
- `🚫 依存未解決` — depends_on に未完了のissueが存在する

対応中のissueは表の末尾にまとめて掲載し、重複着手を防ぐ。

**推奨ロジック：**

`🚫 依存未解決` のissueは推奨候補から除外する。その依存先が未着手であれば、そちらを優先して推奨する。

例：#171（P0, 依存未解決）が #145 に依存している場合：
```
⚠️ 優先度の高い #171 は #145 に依存しています。
   まず #145（P1, 未着手）への着手を推奨します。
```

→ 依存が解決済みの未着手issueの中から最上位を **推奨** として明示し、推奨理由（優先度・MVP 段階・FUTURE_MAP 記載・ラベル等）を1〜2行で説明する。

→ 「対応するissueを選んでください」とユーザーに確認を仰ぐ。選択肢として上位3〜5件を提示する。
　 ユーザーが敢えて `🚫 依存未解決` のissueを選んだ場合は警告を示した上で許可する。

### 5. 決定後のセットアップ

ユーザーがissueを選択したら：

1. **作業ブランチ名の提案**（ブランチ命名規則に沿って）
   - 例: `claude/fix-pwa-53`、`claude/feat-proofreading-95`
2. **関連ファイルのサマリー**（issueタイトル・FUTURE_MAP 記述からキーワードを抽出し、該当しそうなファイルを列挙）
3. **issue本文の確認**（未読の場合は取得して要約を提示）
4. **想定ケースの洗い出し**（[docs/agent-workflows/risk-modeling.md](risk-modeling.md)）— 実装計画に想定ケース表を含める。手順2で列挙した関連ファイルをファイル/領域別チェック観点に当て、不正・異常入力／外部状態変化／非同期・競合／IDB／Tiptap・PM／長文性能／UI失敗状態を一度すべて上げ、対応するもの・見送るもの（理由付き）を分類する。不正系テストの追加を優先候補として扱う。
5. **既存実装調査**（[docs/agent-workflows/codebase-recon.md](codebase-recon.md)）— コードを書き始める前に必須検索セット（類似機能／再利用候補／慣習サンプル／影響箇所／過去の経緯）を実行し、既存実装調査表を実装計画に含める。

ブランチ作成自体はユーザーの承認後に実施する。

### 6. PR作成時のissue関連付け（リマインダー）

作業完了後に `/create-pr` でPRを作成する際は、PR本文またはコミットメッセージに必ず対応issueを明記すること。

**PR本文への記載例：**
```
closes #53
```
または
```
ref: #53
```

この記載により：
- GitHub がPRマージ時にissueを自動クローズする（`closes` / `fixes` / `resolves` のいずれか）
- `list-issues-prs.sh` および `/pick-issue` の次回実行時に「対応中」として正しく検出される
- 重複着手・優先度逆転の防止が機能する

`create-pr.md` の PR 本文テンプレートには `closes #issue番号` の行が含まれるが、書き忘れた場合は `/pick-issue` で「対応中」として認識されないため、必ず確認すること。
