# overlays（consumer 側の repo 固有記述）

このディレクトリは **手編集する正本**。canonical source repo（`agent-commons`）の `core/**` テンプレートが `{{include:<name>}}` で参照する、複数行にわたる repo 固有のブロック（consumer 固有の履歴メモ・プロジェクト固有のセルフレビュー項目等）をここに置く。**1トークン差（パス・コマンド・文書名・issue/PR 番号だけが repo 固有の行）は overlay ファイル化せず、`agent-manifest.json` の `values` で `{{values.<key>}}` として core に直接埋め込む**（値の一覧は `agent-commons` リポジトリの `README.md`「consumer 契約（values）」を正とする）。

## projected file との違い

- **overlay ファイル（このディレクトリ）**: 手編集する。正本。
- **projected file**（`docs/agent-workflows/review-angles/*.md` 等、生成マーカー `<!-- agent-commons:generated ... -->` を持つファイル）: **手編集しない**。canonical source の `core/**` とこのディレクトリから機械的に再生成する。手編集しても drift 検査で検出され、再生成で上書きされる。再生成・検証手順の正本は [`docs/ai/rules/docs-maintenance.md`](../../ai/rules/docs-maintenance.md)「agent-commons の projected file」。

## overlay 一覧

各 overlay がどの core asset のどこに入るか・どういう意図の内容かは、**`agent-commons` の `core/**` にある該当 `{{include:...}}` の直前行に置かれた `<!-- overlay: ... -->` コメントを正本とする**（ここに複製しない。drift の原因になるため）。以下は名前と1行の役割のみ。

| overlay 名 | 1行の役割 |
|---|---|
| `review-angles-readme.bench-history.md` | 既知穴コーパス検出ベンチの実施履歴（consumer 固有の実測値） |
| `review-angles-readme.history-notes.md` | README 関連の issue 履歴メモ（consumer 固有） |
| `pre-commit-review.project-checks.md` | プロジェクト固有のセルフレビュー項目一式（§5 本文） |
| `angle-adversarial.attack-surface-refs.md` | 攻撃面ガード要件の consumer 固有の実例 |

overlay ファイルの内容に `{{...}}`（`{{include:...}}` / `{{values.*}}` / `{{targets.*}}` / `{{exec.*}}`）を含めることは**できない**（render.js がテンプレート render 時に拒否する。overlay は repo 固有の完結したブロックであり、プレースホルダは core 側に置く）。

## 命名規則

`<docKey>.<意味を表す短い名前>.md`（例: `review-angles-readme.bench-history.md`）。`docKey` は抽出元ドキュメント（`review-angles-readme` / `angle-<系統名>` / `pre-commit-review` / `review-pr`）を表す。1ファイル = 完結した文またはブロック（末尾に改行を1個持つ）。

## 変更手順

1. 該当する overlay ファイルを直接編集する（複数行ブロックはブロック全体を保つ。書式・見出し階層は元の core asset の位置に合わせる）。
2. 再生成・検証コマンドの正本は [`docs/ai/rules/docs-maintenance.md`](../../ai/rules/docs-maintenance.md)「agent-commons の projected file」（要約: `AGENT_COMMONS_PATH=<agent-commons のローカル checkout> npm run agents:project` → `npm run agents:check`。`agents:project` は orphan を削除しないので、registry から asset を削除して旧 projected file を消したい場合のみ `npm run agents:project -- --prune` を使う。commons へアクセスできない担当者の引き継ぎ方も同ファイルに記載がある）。
