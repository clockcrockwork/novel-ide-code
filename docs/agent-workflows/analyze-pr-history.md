# PR履歴分析・繰り返し防止自動化

> **Ground truth:** `docs/pr/PR-*.md`（レビュー対応ログ）/ `eslint.config.js`（既存ルール）/ [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)
> **Entry gate:** `node scripts/analyze-pr-history.js --save` を実行し `docs/pr-analysis/items.json` を生成するまで予防ルール化に進まない
> **Required artifacts:** 分類結果、追加した lint ルール表、REVIEW_GUIDELINES 追記（あれば）、完了報告
> **Verification gate:** lint ルール追加時は `npm run lint`（既存違反を放置しない）。[docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。新規ルールで既存違反を残さない
> **Cost note:** 機械化を怠ると同種の指摘が PR ごとに再発し、AIレビュー前ゲートに落とせる項目が手作業に残る

引数: なし。

`docs/pr/PR-*.md` に蓄積されたレビュー対応ログを解析し、
繰り返し発生している問題を「lint ルール」または「チェックリスト」として予防ルール化する。

**責務分離**:
- **スクリプト** (`scripts/analyze-pr-history.js`) — 全 PR ファイルをパース・キーワード分類・JSON 出力（決定論的）
- **このワークフロー** — 意味的分類・lint 実装判断・REVIEW_GUIDELINES 更新判断（意味理解が必要な部分）

> **#353 段階B への入力（#444）**: `docs/pr/PR-*.md` の `## レビュー振り返り` セクション（[review-retrospective.md](review-retrospective.md)）は横断集計の対象。派生 JSON は本分析の実行時に生成する（PR ごとの手動更新はしない）。現行スクリプトは同セクションを読まない（表・日付見出しを使わない書式のためパースに影響しない）。

## 手順

### 1. スクリプト実行

```bash
node scripts/analyze-pr-history.js --save
```

- Markdown レポートを標準出力に出力する
- `--save` を付けると `docs/pr-analysis/` に以下を保存する（#353 段階B）:
  - `items.json` — 従来互換（✅対応済みのみ・11フィールド）
  - `detailed-items.json` — 全判断（✅/⏭️/🔁/❓）＋多軸フィールド（`judgment_norm` / `primary_area` / `disposition_reason` 等。スキーマ正本: `docs/planning/pr-history-schema-design.md`）。判断セルが既知記号で始まらない行（非レビュー表の誤パース等）は隔離され件数が stderr に出る
  - `risk-patterns.json` — `primary_area` 別集計（[risk-modeling.md](risk-modeling.md) §2.5 が領域キーで引く）
  - `risk-patterns.md` — 領域別の可読レポート
- 多軸フィールドは best-effort の自動プリフィル（`confidence: auto`）。`primary_area=unclassified` / `disposition_reason=unknown` は curation（段階C）で解消する
- 出力をファイルに保存する場合: `node scripts/analyze-pr-history.js --save > docs/pr-analysis/latest.md`

### 2. 「Lintで防げる可能性あり」セクションの精査

スクリプト出力の **Lintで防げる可能性あり** セクションを読み、各項目について以下を確認する：

1. **既存ルールで対処済みか？** — `eslint.config.js` を開いて重複確認
2. **機械的に検出できる形に落とし込めるか？** — 同じパターンが 3 件以上ある場合は優先的に lint 化
3. **lint ルールの種類を判定**:
   - 既存 npm パッケージで対応できる → パッケージ追加を提案
   - AST パターンが単純 → `eslint.config.js` 内 `localPlugin` に custom rule を追加
   - AST パターンが複雑 → まずチェックリストに追加して様子を見る

### 3. 「その他」の意味的分類

`docs/pr-analysis/detailed-items.json` を読み込み、`primary_area: "unclassified"`（旧: items.json の `category: "other"`）のアイテムを確認する。curation（段階C）では `failure_types` / `root_causes` / `risk_cases` / `disposition_reason` を補完し `confidence: "curated"` へ昇格する。

以下の観点でグルーピングする：
- **繰り返し頻度**: 同種の問題が 3 件以上 → 予防ルール化の優先度高
- **影響範囲**: バグリスク・セキュリティ > UX > コードスタイル
- **lint 化可否の再評価**: キーワードに引っかからなかったが AST パターンで検出できそうなもの

分類後、各グループを「lint 候補」「チェックリスト候補」「設計判断（省略）」に振り分ける。

### 4. Lintルール実装

**優先度判定基準:**
- P0（必須実装）: セキュリティ・データ破壊リスクがあるパターン、3 件以上の繰り返し
- P1（推奨）: バグリスクがある、または 2 件の繰り返し
- P2（任意）: コード品質向上、1 件のみ

**実装パターン（`eslint.config.js` 内 `localPlugin`）:**

```js
'rule-name': {
  create(context) {
    return {
      // ASTノードタイプ: https://eslint.org/docs/latest/extend/custom-rules
      CallExpression(node) {
        // 検出ロジック
        context.report({ node, message: 'メッセージ（日本語）' });
      },
    };
  },
},
```

実装後に動作確認:
```bash
npm run lint
```

lint エラーが出た場合は既存コードを修正してから再実行する（新規ルールで既存違反を放置しない）。

### 5. チェックリスト更新（最小限）

**追加基準**:
- lint で機械的に検出できない
- かつ、過去に複数の PR で同種の問題が発生している
- かつ、発生した場合のリスクが高い（バグ・セキュリティ・UX 破壊）

上記 3 条件をすべて満たす場合のみ `docs/REVIEW_GUIDELINES.md` に 1 行追記する。
追加場所は既存のチェックリストセクションの該当カテゴリ内。

**追加しない**: コード品質向上・リファクタリング促進・ドキュメント改善など、lint では難しいが
致命的でもないものはチェックリストに追加しない（コンテキスト圧迫を避ける）。

### 6. 完了報告

```markdown
## PR履歴分析・予防ルール化 完了

### 追加したLintルール
| ルール名 | 検出対象 | 根拠PR |
|---------|---------|--------|
| ...     | ...     | ...    |

### REVIEW_GUIDELINES 追記（あれば）
- 追記内容と根拠

### 「その他」の意味的分類結果
- 分類できたグループ数・件数
- 次回スクリプトのキーワード候補（任意）

### レビュー網羅性の外生指標（review-angles 効果測定。#397）
- 外部レビュー（Gemini / Codex / 人間）の実質新規所見数/PR を、観点別レビュー導入前後の PR 群で比較する（実質新規 = 既存所見の言い換え・resolved 済みを除く。導入前後は docs/agent-workflows/review-angles/ の導入 PR を境に区切る）
```
