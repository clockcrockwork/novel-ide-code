# PR前セカンドオピニオンレビュー（#357）

> **Ground truth:** issue #357（採用方針・重視観点の正本）/ [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) / `docs/planning/quality-ai-public-readiness-plan.md` Q4 決定（高リスク変更のみ・任意運用から開始）
> **Entry gate:** 対象変更が「高リスク領域」（下記 [§1](#1-対象entry-gate-高リスク変更のみq4-決定)）に該当するか判定するまでレビュー依頼に進まない。該当しない場合は本手順自体をスキップしてよい（docs-only・小さな文言修正は対象外）
> **Required artifacts:** セカンドオピニオン記録（provider 名・指摘一覧・**採否と理由**）。PR 本文に記載、レビュー対応が発生した場合は `docs/pr/PR-{番号}.md` へ
> **Verification gate:** レビュー指摘を修正した場合は変更種別に応じた verification gate を再実行して green（[verification-gates.md](../ai/rules/verification-gates.md)）。最低限 `npm run check`（lint / thresholds / test）、import 追加・削除やファイル移動などの構造変更を伴う場合は `npm run build` も再実行する（`check` は build を含まない）。指摘への採否が全件記録されていること
> **Anti-skip:** 「plugin が無いのでレビュー省略」は禁止 — provider を [§2](#2-provider-の選択フォールバック順) の順でフォールバックする。「指摘ゼロだったので記録不要」も禁止 — 実行した provider と結果ゼロを 1 行残す
> **Cost note:** PR 前の第三者視点を飛ばすと、データ損失・Tiptap transaction 破壊・persistence 破綻のような高コスト欠陥が PR レビュー（Gemini/人間）まで素通りし、レビューラウンドが増える

Claude Code で実装した高リスク変更を、**PR 作成前に read-only の査読者へ通す**運用。修正の実施は常に Claude Code 側が行い、レビュアー（Codex 等）には書かせない（#357）。

## 1. 対象（Entry gate）: 高リスク変更のみ（Q4 決定）

以下のいずれかに触れる変更が対象。**該当しなければ本手順は不要**（必須化しない。試行運用の結果を見て再判断）:

- editor（Tiptap / ProseMirror の schema・transaction・selection・history）
- persistence（IndexedDB / localStorage 正規化 / hydrate）
- GitHub sync / Worker（認証・repo 境界・push/pull）
- security boundary（外部入力検証・sanitize・token）
- export / import
- 本文処理の性能（長文 O(N) 走査・Unicode）

## 2. Provider の選択（フォールバック順）

レビューという**ゲートは provider に依存させない**。上から順に使えるものを選ぶ。どれを使ったかを記録に残す。

| 順 | Provider | 前提 | 実行 |
|----|----------|------|------|
| A（推奨） | **Codex**（`codex-plugin-cc`） | plugin 導入 + ChatGPT ログイン済み（**人間がローカルで設定**。API 従量課金は使わない） | [§3](#3-provider-a-codexcodexreview) |
| B（fallback） | **Claude Code 内蔵レビュー** | 常時利用可 | [§4](#4-provider-b-claude-code-内蔵レビューfallback) |
| C（補完・PR 後） | ~~**Gemini**（PR 上の `/gemini review`）~~ **退役済み** | — | 観点別レビュー（[review-angles/README.md](review-angles/README.md)）＋機械ゲート（#452）へ内製化。過去の指摘傾向の分析は本ファイル末尾の注記を参照 |

- A が使えるかは `/codex:review` を打てば分かる（未導入なら `Unknown command`）。**未導入でもレビューを省略せず B へ**。
- B は同系モデルの自己レビューで独立性が下がるため、[§4](#4-provider-b-claude-code-内蔵レビューfallback) の敵対的観点プロンプトで補う。**独立アンカーは Codex（A）・別モデル・修正コンテキストを持たないサブエージェントで確保する**（Gemini 退役後は provider C に依存しない）。
- **Gemini 退役の経緯（記録）**: Gemini コードレビュアーはサービス終了により退役した。コーパス調査（PR #433/434/440/441/448/449/450）で、Gemini 固有の指摘は防御的コーディング・規約・ナビ nit に偏り、既存の敵対的・コード品質系統が**起動していれば**拾える範囲が大半であること、深い運用可能性・状態遷移・情報設計の指摘はむしろ Codex が先行していたことが判明した。よって「Gemini 互換レビュアーの追加」ではなく、(1) 運用性・状態遷移系統の新設（PR #451）、(2) Tier 宣言×系統列の起動漏れ機械検査（#452）で観点の穴と起動漏れを構造的に塞いだ。

## 3. Provider A: Codex（`/codex:review`）

初回セットアップ（人間・ローカル。エージェントは実行しない）:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

実行フロー（#357 の想定ワークフロー）:

```text
npm run check                                  # green を確認してから依頼
/codex:review --base main --background
/codex:status                                  # 完了待ち
/codex:result
```

その後:

- Claude Code が指摘を [§5](#5-指摘の分類と採否記録required-artifacts) の基準で分類・採否判断・修正
- 変更種別に応じた verification gate を再実行（最低限 `npm run check`。構造変更を伴うなら `npm run build` も。[verification-gates.md](../ai/rules/verification-gates.md) 準拠）
- 必要なら `/codex:review --base main --wait` で再レビュー

重大変更（データ損失・エディタ状態・persistence に直結）では追加で:

```text
/codex:adversarial-review --base main data loss, editor state corruption, Tiptap transaction mistakes, persistence regressions
```

原則（#357「採用しないもの」）: 自作 MCP server / `codex exec` 独自プロンプト / Codex に修正まで任せる常用 / `--yolo` 系の危険実行は使わない。Codex は read-only 査読者。

## 4. Provider B: Claude Code 内蔵レビュー（fallback）

1. `/code-review high` を実行し、指摘を修正。
2. security boundary に触れる場合は `/security-review` も実行。
3. 自己レビューの独立性低下を補うため、#357 の重点観点を敵対的プロンプトとして明示的に与える:

> この差分を敵対的にレビューせよ。特に: データ損失 / 本文保存正本との不整合 / Tiptap v3 の schema・transaction・selection・history 破壊 / エディタ状態の破損 / local persistence・import・export・sync 前提の破綻 / 不正系・境界値テスト不足 / O(n) 走査など入力体験に影響する性能劣化 / security・secret・dependency risk / MVP-alpha 方針との不整合

## 5. 指摘の分類と採否記録（Required artifacts）

provider を問わず、指摘は**鵜呑みにせず**以下で分類し、採否理由を必ず残す（[review-pr.md](review-pr.md) のトリアージと同じ ✅/⏭️/🔁/❓ 基準）:

- **PR前ブロッカー候補**（必ず解決 or 明示的却下理由）: #357 の重点観点 = データ損失 / 本文保存正本との不整合 / Tiptap schema・transaction・selection・history 破壊 / persistence・import・export・sync の破綻 / 不正系・境界値テスト不足 / 入力体験に効く性能劣化 / security・secret・dependency risk / MVP-alpha 方針との不整合
- **非ブロッカー**: 上記以外。対応するか、見送り理由を 1 文で記録

**記録フォーマット**（PR 本文に記載。レビュー対応が発生したら `docs/pr/PR-{番号}.md` にも）:

```markdown
## セカンドオピニオン記録

- Provider: codex（/codex:review --base main）｜claude-code（/code-review high + 敵対的観点）
- 指摘: {n} 件（ブロッカー候補 {n} / 非ブロッカー {n} / 指摘ゼロならその旨）

| # | 指摘要旨 | 分類（ブロッカー/非ブロッカー） | 採否（✅/⏭️/🔁/❓） | 理由 |
|---|---------|------------------------------|--------------------|------|
```

## 6. 運用ステータスと再判断

- 現状: **任意運用（試行フェーズ）**。数 PR で試行し、指摘分類と採否記録が安定してから必須化を再判断する（Q4）。
- 必須化の判断材料として、試行 PR の記録（[§5](#5-指摘の分類と採否記録required-artifacts)）を蓄積する。⏭️ 見送りの理由は #353 の `disposition_reason` 分類（`docs/planning/pr-history-schema-design.md` §3.7）に将来接続する。
- plugin 導入状況・ChatGPT ログインは人間管理。エージェントは導入状態を**検出して provider を選ぶ**だけで、導入作業を代行しない。

## 関連

- issue #357（採用方針の正本）/ #353（採否記録の還流先）
- [create-pr.md](create-pr.md) — 高リスク変更では手順 1.5（本手順の条件付きステップ）で PR 作成前に挟む
- [review-pr.md](review-pr.md) — PR 作成**後**のレビュー対応の実行手順（Provider C を含む）。規約の正本 [rules/review.md](../ai/rules/review.md) とは役割が異なる別ファイル
- `docs/planning/quality-ai-public-readiness-plan.md` §AI review workflow roadmap
