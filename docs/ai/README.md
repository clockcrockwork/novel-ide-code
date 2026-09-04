# AI作業ルール入口

AIエージェント（Claude / Codex / Copilot 等）が作業を開始する際に参照する索引ドキュメント。

**このファイルの役割：**
- タスク種別ごとに「何を読むべきか」を示す
- 詳細ルール本文への参照先を一元管理する

**AGENTS.md / CLAUDE.md / copilot-instructions.md の役割：**
- 常時遵守する最低限の原則と、各エージェント固有の起動設定のみを記載する
- 詳細ルール・作業手順・チェックリストの本文をこれらのファイルに追加しない
- ルールを追加・変更する場合は `docs/ai/rules/` または `docs/agent-workflows/` に置き、参照先一覧のみを更新する

**全タスク横断（検索型永続記憶）：**
- タスク種別によらず、設計判断・制約・不変条件・例外・不採用理由・教訓・レビュー観点に関わる作業の**前に** `node scripts/agent-memory.js search "<キーワード>"` で既存の記憶を引く（過去決定の再導出・再議論を避ける）。詳細・CLI 一覧は [`docs/agent-memory/README.md`](../agent-memory/README.md)。
- 新しい決定・教訓は `add`（必ず `status: proposed`）で追加し、`promote` / `reject` / `retire` / `supersede` と（secret 混入時の）`purge` は判断が人間の操作として `--endorsed-by <人間>` で endorse をコミット trailer に残す（人間の指示なしに付けない）。

**全タスク横断（責務境界）：**
- 「誰が決めるか」（machine / AI / human）・工程間ハンドオフの最小項目・知識の置き場（正本 / 観測 / 記憶 / 意図）は [`docs/ai/rules/responsibility-boundary.md`](rules/responsibility-boundary.md) を正とする。machine が判定できる所見は所見ではなくゲートの欠落として扱う。

**全タスク横断（簡潔化）：**
- ユーザー対話・issue 本文・PR 本文・恒久 docs の簡潔化規則は [`docs/ai/rules/communication.md`](rules/communication.md) を正とする。

---

## タスク分類と必読ファイル

| タスク種別 | 必読ファイル |
|-----------|------------|
| **機能実装・バグ修正** | [CLAUDE.md](../../CLAUDE.md)（または [AGENTS.md](../../AGENTS.md) / [copilot-instructions.md](../../.github/copilot-instructions.md)）<br>[`docs/ai/rules/implementation.md`](rules/implementation.md)（ground truth・artifact・gate）<br>[`docs/agent-workflows/requirement-probe.md`](../agent-workflows/requirement-probe.md)（完了条件の洗い出し）<br>[`docs/agent-workflows/risk-modeling.md`](../agent-workflows/risk-modeling.md)<br>[`docs/agent-workflows/codebase-recon.md`](../agent-workflows/codebase-recon.md)（実装前の既存実装調査）<br>[`docs/data-model/INVARIANTS.md`](../data-model/INVARIANTS.md) |
| **オーケストレーション・サブエージェント移譲** | [`docs/agent-workflows/subagent-roles.md`](../agent-workflows/subagent-roles.md)（ロール定義・移譲計画・標準フローの正本）<br>[`docs/ai/rules/responsibility-boundary.md`](rules/responsibility-boundary.md)（責務境界・ハンドオフの最小項目）<br>[`docs/agent-workflows/evidence-check.md`](../agent-workflows/evidence-check.md)（完了証拠の検証・ドリフト監査） |
| **PRレビュー** | [`docs/ai/rules/review.md`](rules/review.md)（遡及チェック・競合確認）<br>[`docs/REVIEW_GUIDELINES.md`](../REVIEW_GUIDELINES.md)（コーディング規約・詳細判断基準）<br>[`docs/agent-workflows/review-retrospective.md`](../agent-workflows/review-retrospective.md)（レビュー収束後の発生原因・内部検出漏れ分析。review-pr ステップ7.5） |
| **PR作成前セカンドオピニオン（高リスク変更のみ）** | [`docs/agent-workflows/second-opinion-review.md`](../agent-workflows/second-opinion-review.md)（Codex `/codex:review` 優先・未導入時フォールバック・採否記録） |
| **リファクタリング** | [`docs/maintenance/code-cleanup.md`](../maintenance/code-cleanup.md)（判断基準）<br>[`docs/agent-workflows/code-cleanup.md`](../agent-workflows/code-cleanup.md)（手順） |
| **テスト追加・修正** | [`docs/REVIEW_GUIDELINES.md`](../REVIEW_GUIDELINES.md)（「テスト必須カテゴリ」節） |
| **セキュリティ対応** | [`docs/security/TRUST-BOUNDARY.md`](../security/TRUST-BOUNDARY.md)<br>[`docs/REVIEW_GUIDELINES.md`](../REVIEW_GUIDELINES.md)（「セキュリティレビュー」節） |
| **ドキュメント更新・ルール追加** | [`docs/ai/rules/docs-maintenance.md`](rules/docs-maintenance.md) |
| **AIスキル作成・統廃合** | [`docs/agent-workflows/skill-design-rubric.md`](../agent-workflows/skill-design-rubric.md)（6項目ルーブリック）<br>`docs/agent-workflows/` 該当スキルの手順ファイル<br>[`docs/ai/rules/docs-maintenance.md`](rules/docs-maintenance.md) |
| **CI / GitHub Actions** | [`docs/REVIEW_GUIDELINES.md`](../REVIEW_GUIDELINES.md)（「GitHub Actions / CI」節）<br>`docs/security/` 関連ドキュメント |

---

## タスク分類ごとの ground truth / 必須 artifact / verification gate

作業開始前に ground truth（判断基準となる正本）を固定し、必須 artifact を揃えてから着手する。
完了後は verification gate をすべて通過してから PR を作成する。

| タスク種別 | ground truth | 必須 artifact | verification gate |
|-----------|-------------|--------------|------------------|
| **機能実装・バグ修正** | [MVP_PLAN.md](../MVP_PLAN.md)<br>[INVARIANTS.md](../data-model/INVARIANTS.md)<br>[ARCHITECTURE.md](../ARCHITECTURE.md) | 完了条件チェックリスト（[requirement-probe.md](../agent-workflows/requirement-probe.md)）<br>リスクモデリング表<br>既存実装調査表（[codebase-recon.md](../agent-workflows/codebase-recon.md)）<br>変更対象ファイル一覧 | lint通過 / test通過<br>pre-commit-review完了（レビューループ記録＋収束宣言を含む）<br>証拠表（[evidence-check.md](../agent-workflows/evidence-check.md)）+ `npm run check:artifacts`（コード変更PRは機械ゲート必須）<br>[checklists/pre-pr.md](checklists/pre-pr.md)<br>手順本文は [rules/implementation.md](rules/implementation.md) / [agent-workflows/create-pr.md](../agent-workflows/create-pr.md) を正とする |
| **PRレビュー** | [REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)<br>[rules/review.md](rules/review.md) | 遡及チェック結果<br>競合確認結果<br>レビュー振り返り（`docs/pr/PR-{番号}.md`。対象がある場合のみ。[review-retrospective.md](../agent-workflows/review-retrospective.md)） | 全コメントにトリアージ判断と返信 |
| **PR作成前セカンドオピニオン**（高リスク変更のみ） | issue #357<br>[second-opinion-review.md](../agent-workflows/second-opinion-review.md) | セカンドオピニオン記録<br>（PR本文 / `docs/pr/PR-{番号}.md`） | `npm run check` green<br>指摘への採否全件記録 |
| **リファクタリング** | [maintenance/code-cleanup.md](../maintenance/code-cleanup.md) | 挙動変更ゼロの確認 | lint通過 / test通過<br>要求外変更なし確認 |
| **セキュリティ対応** | [TRUST-BOUNDARY.md](../security/TRUST-BOUNDARY.md)<br>[REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) | 攻撃面（attack surface）リスト | security-review完了 |
| **ドキュメント更新** | [docs/ai/README.md](README.md)（置き場ガイドライン） | 反映先チェックリスト<br>（[docs-maintenance.md](rules/docs-maintenance.md)） | リンク切れなし<br>遡及判断済み |
| **テスト追加・修正** | [REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)（「テスト必須カテゴリ」節） | 追加対象カテゴリ確認 | lint通過 / test通過 |
| **AIスキル作成・統廃合** | `docs/agent-workflows/` 該当スキル手順<br>[docs-maintenance.md](rules/docs-maintenance.md) | 反映先チェックリスト<br>（[docs-maintenance.md](rules/docs-maintenance.md)） | リンク切れなし<br>遡及判断済み |
| **CI / GitHub Actions** | [REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)（「GitHub Actions / CI」節）<br>`docs/security/` 関連ドキュメント | ― | security-review完了 |

---

## anti-skip rule

以下の理由でのスキップは禁止する。

- 「小さい変更なので検証不要」
- 「既存に合わせたので確認不要」
- 「ドキュメントのみなので lint / test 不要」
- 「テストがない領域なので追加不要」
- 「リスクモデリングは自明なのでスキップ」
- 「レビュー済みなので修正後の再レビュー不要」（修正コミットもレビュー対象。新規所見ゼロを観測するまでループする — ただし枠を超えたら自動で回さず人間判断へ返す。正本: [pre-commit-review.md](../agent-workflows/pre-commit-review.md)「レビューループ」「周回の上限（移行期）」）
- 後段工程（中間監査 等）の**無言スキップ**（工程自体を実施しない場合は「実施しない＋理由」を成果物に宣言として残す。ただし、実施した結果「該当ゼロ」だった場合の「なし宣言」は、機械ゲートが検査する箇所（Tier 宣言・`関連issue: なし（理由）` 等）を除き不要。宣言なしは「実施して該当ゼロ」を意味し、監査で実施有無を問われた場合は実施の経緯を答えられること）
- 「新規実装（または既知のコードベース）なので既存実装調査は不要」

スキップが必要な例外的事情がある場合は、PR 本文に理由を明記する。

**ループを含む工程の下限**: 「〜まで繰り返す」型の手順は、周回ごとの1行記録と収束宣言（新規所見ゼロ / 上限到達＋残所見列挙）を必須 artifact とする。「1周やった」を「収束した」と偽装できないようにするため（設計基準: [skill-design-rubric.md](../agent-workflows/skill-design-rubric.md)、機械検査: `npm run check:artifacts` の「レビューループ記録」セクション）。

**plan モードの下限**: コード変更を含む plan には、想定ケース表・既存実装調査表を埋めるか `/risk-modeling` `/codebase-recon` の実行を工程として明記する。ExitPlanMode 時に plan ゲート（`scripts/agent/hooks/check-plan-gates.js`）が機械検査する（[rules/verification-gates.md](rules/verification-gates.md)）。

---

## docs/ai/rules/ の構成

| ファイル | 内容 |
|---------|------|
| `implementation.md` | 機能実装・バグ修正のルール（ground truth 固定・artifact・gate・anti-skip） |
| `review.md` | PRレビュー時の遡及チェック・競合確認手順 |
| `docs-maintenance.md` | ルール追加・変更時の反映先チェックと遡及判断フロー |
| `verification-gates.md` | 変更種別ごとの verification gate（実在 npm script）と機械的検出の寄せ先 |
| `ci-run.md` | GitHub Actions CI の起動単位（push と分離した明示起動）・状態遷移・マージまでの手順 |

## docs/ai/checklists/ の構成

| ファイル | 内容 |
|---------|------|
| `pre-pr.md` | PR作成前の最終確認チェックリスト（anti-skip 確認を含む） |

---

## ドキュメント置き場のガイドライン

新しいルールを追加するとき、どこに書くか迷ったら以下を参照する。

| 種別 | 置き場所 |
|------|---------|
| セルフレビュー項目・コーディング規約 | `docs/REVIEW_GUIDELINES.md` |
| タスク種別ごとのオペレーション手順 | `docs/ai/rules/*.md` |
| 変更種別ごとの検証コマンド（verification gate） | `docs/ai/rules/verification-gates.md` |
| CI の起動タイミング・マージ可否の状態遷移 | `docs/ai/rules/ci-run.md` |
| スキルとして実行する定型フロー | `docs/agent-workflows/*.md` |
| スキル/ワークフロー設計の最低基準（6項目） | `docs/agent-workflows/skill-design-rubric.md` |
| 判断基準・設計方針 | `docs/maintenance/*.md` |
| アーキテクチャ詳細 | `docs/ARCHITECTURE.md` |
| 設計決定・制約・不変条件・例外・不採用案・教訓・レビュー観点（検索層・セッション横断で引く） | `docs/agent-memory/records/*.json`（CLI で `add` / `search`。正本は [`docs/agent-memory/README.md`](../agent-memory/README.md)） |
| エージェント固有の起動設定 | CLAUDE.md / AGENTS.md / copilot-instructions.md（参照先のみ） |
