# PR作成

> **Ground truth:** [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)（PR・コミットの作法）/ 対応Issue / [docs/ai/checklists/pre-pr.md](../ai/checklists/pre-pr.md)
> **Entry gate:** [pre-commit-review.md](pre-commit-review.md) を全項目パスし、想定ケース表が揃うまで PR 作成に進まない
> **Required artifacts:** PR本文（提供結果（必要な理由を含む）/ 最終的な変更 / 完了条件 / 想定ケース / 既存実装調査 / 証拠表 / レビューループ記録 / 残る制約・判断 / `closes #issue番号`）、フィーチャーブランチ
> **Verification gate:** [pre-commit-review.md](pre-commit-review.md) 完了（lint / test / build）+ `npm run check:artifacts`（コード変更 PR）。変更種別別は [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。`main` への直接 push 禁止・PR の単位（1 PR = 1 つの自己完結した提供結果）を崩さない
> **Cost note:** `closes #issue番号` 欠落で自動クローズ・「対応中」検出が働かず、重複着手・優先度逆転を招く

コミット前セルフレビューを自動実施し、パスしたら [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) の作法に従って PR を作成する。

## 手順

### 1. コミット前セルフレビュー（自動）

[docs/agent-workflows/pre-commit-review.md](pre-commit-review.md) に従う。

すべての項目でパスするまで PR 作成に進まない。想定ケース表（[risk-modeling.md](risk-modeling.md)）が作られ「今回対応しないもの」に理由（⏭️ は前提付き＝依存する外部状態を名指し）が付いているかも、この工程の確認に含まれる。

### 1.5 高リスク変更のセカンドオピニオン（条件付き）

変更が高リスク領域（editor / persistence / GitHub sync / Worker / security boundary / export-import / 本文処理の性能）に触れる場合、PR 作成前に [second-opinion-review.md](second-opinion-review.md) を実施することを検討する。

- 該当しない場合（docs-only・小さな文言修正等）はこのステップをスキップしてよい。
- 実施した場合は「セカンドオピニオン記録」（provider・指摘・採否理由）を PR 本文に含める。
- **現状は任意運用（試行フェーズ）**。合意のうえ見送る場合は、見送り理由を PR 本文に記録すれば PR 作成に進んでよい（[pre-pr.md](../ai/checklists/pre-pr.md) の該当項目と整合）。必須化は試行後に再判断する。

### 2. ブランチ確認

`git status` と `git log --oneline -5` で現在のブランチと変更履歴を確認する。

- `main` ブランチへの直接 push は禁止。必ずフィーチャーブランチから PR を作成する。
- ブランチ名が `{agent}/{purpose}` 形式（例: `claude/fix-xss-markdown`）になっているか確認する。なっていない場合はユーザーに確認する。

### 3. PR 本文の作成

[docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) の「PR・コミットの作法」に従い、以下を含む PR 本文を作成する：

本文は簡潔にする: commit ごとの作業日誌・レビューコメントの再掲・恒久 docs の本文複製は書かない（経緯は commit ログと PR スレッドが持つ）。

```markdown
## 提供結果

<!-- この PR で何が使える・良くなるか（1〜3 行）。なぜ必要か（問題・動機）も一体で書く -->

## 最終的な変更

<!-- 最終状態の変更の概要を箇条書きで（途中経緯は書かない） -->

## 完了条件

<!-- requirement-probe の完了条件チェックリストを転記。検証方法付き -->

## 想定ケース

<!-- risk-modeling の想定ケース表。対応する/しない＋理由（⏭️ は前提付き） -->

## 既存実装調査

<!-- codebase-recon の調査表。実行した検索クエリ・ヒット・再利用/準拠/新規の判断＋理由 -->

## 証拠表

| 宣言 | 証拠 | 判定 |
|---|---|---|
| （完了主張） | （ファイル:行 / テスト名 / 実行コマンドと結果） | ✅ |

## レビューループ記録

Tier: （Full / Light / 設計文書 / Record / Docs / {基礎 Tier}＋設計文書 / なし）（判定理由1行）
実効Tier: （加算があった場合のみ。無ければ行ごと削除）（昇格理由1行）

| 周回 | 系統 | 新規所見 | 対応 |
|---|---|---|---|
| 1 | （系統名） | （n件・要旨） | 全修正＋（昇格判断） |
| （最終周） | （対象系統） | 0件 | 収束 |

## 残る制約・判断

<!-- マージ後も残る制約・ユーザーに委ねる判断・issue 候補（無ければ節ごと省略） -->

closes #issue番号
```

**「完了条件」「想定ケース」「既存実装調査」「証拠表」「レビューループ記録」はコード変更 PR で必須**（CI の `artifacts-gate` が存在・非空・証拠形式・収束宣言・関連 issue 参照を機械検証する）。説明・記録文書のみの PR では省略可。ただし**実行可能設計文書**（[review-angles/README.md](review-angles/README.md) の加算規則のパス）に触れる docs のみ PR は、「レビューループ記録」（Tier 宣言行 `Tier: 設計文書（理由）`＋仕様・運用性の実施記録）を省略しない。過剰トリガー（誤字修正等）を免除する場合は Tier 宣言行 `Tier: なし（説明・記録文書: 理由）` のみ記載しループ表は省略可（書式の正本は README「収束と記録」。`artifacts-gate` が Tier 宣言×系統列の突き合わせも機械検証する #452）。証拠表の書式は [evidence-check.md](evidence-check.md)「機械的下限ゲート」、レビューループ記録は [pre-commit-review.md](pre-commit-review.md) ステップ6 を参照。レビューループ表を転記する際は、記憶適合起動判定行（[review-angles/README.md](review-angles/README.md)「条件起動系統」）も表の直後へ一緒に転記する。外部レビュー由来の正当な新規所見等で系統が加算された場合は、**実効 Tier 宣言行**（`実効Tier: {宣言名}（昇格理由1行）`）を Tier 宣言行の直後へ置く（加算が無ければ行ごと省略する。`artifacts-gate` は宣言があれば実効 Tier を必須系統の基準にし、初期 Tier より縮小する宣言を拒否する。正本: README「実効 Tier の更新」「収束と記録」）。例外は `<!-- artifacts-check: skip (理由) -->` の明記でのみ許可。

`closes #issue番号` は必須。対応issueがない場合は行ごと削除し、代わりに `関連issue: なし（理由）` を明記する（コード変更 PR は issue 参照か「なし宣言」のどちらかがないとゲートで落ちる）。
`closes` を書くことで PR マージ時に GitHub がissueを自動クローズし、`/pick-issue` の次回実行時に「対応中」として正しく検出される。
1 issue を複数 PR で進める場合は、issue を完了させる最終 PR のみ `closes` とし、途中 PR は `refs #issue番号` を使う（早期の自動 close を防ぐ。[REVIEW_GUIDELINES「issue の作成・close」](../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本)）。

- コメント・PR 説明はすべて日本語で書く
- 1 PR = 1 つの自己完結した提供結果になっているか確認する（分割してよい条件は [REVIEW_GUIDELINES「PR の単位」](../REVIEW_GUIDELINES.md#pr-の単位正本)）
- 複数 issue を close する場合は `closes` を並記してよい

### 3.5. artifact ゲートのローカル事前確認

PR 作成前に、下書きした本文がゲートを通ることをローカルで確認する（CI で赤にしてから直すより速い）：

```bash
npm run check:artifacts -- --body-file <本文の下書きファイル> --base origin/main
```

`check-artifacts: OK` にならない場合は指摘されたセクション・証拠を埋めてから PR を作成する。

### 4. リモートへ push して PR を作成

```bash
git push -u origin <現在のブランチ名>
gh pr create --title "<タイトル>" --body "<本文>"
```

PR タイトルは変更内容を端的に表す日本語（または `feat(scope): 説明` 形式）にする。

作成後、PR の URL をユーザーに伝える。

### 4.5. 内部レビュー所見の裁定を転記する（PR 番号確定後）

[pre-commit-review.md](pre-commit-review.md) で観点別レビュー・`/security-review` を実施し所見が出ていた場合、**ステップ4で確定した PR 番号**を使って `docs/pr/PR-{番号}.md` の `## 内部レビュー所見の裁定` へ裁定（判断・理由・対応・証拠）を転記し、**追加コミットして push する**（PR 本文ではなくリポジトリ側の恒久記録に載せるため、push まで行って初めて完了）。

- **番号確定前には実行できない**。ステップ3以前に置くと、まだ存在しない番号でファイル名を決めることになる
- 書式は `docs/pr/TEMPLATE.md` の同節。**表形式にしない**（`scripts/analyze-pr-history.js` が `|` 始まりの行をファイル全体で走査し、外部レビュー指標の母集団へ混入するため）
- **転記対象は内部 provenance の所見すべて** — 観点別レビュー・`/security-review` に加え、**ステップ1.5 のセカンドオピニオン**（orchestrator が起動したもの）も含む。`second-opinion-review.md` の既存書式は表形式だが、`docs/pr/PR-{番号}.md` へ入れる際は**非表形式へ直す**（表のままだと `analyze-pr-history.js` が外部所見として集計する）
- **転記コミットの差分にも verification gate を適用する** — このコミットは tracked file を変更するため、該当種別のゲート（docs のみなら `npm run docs:links:check`）を実行してから push する。ステップ1・3.5 はこのコミットより前なので、転記差分は未検証のままになる
- 所見が 0 件だったラウンドは転記不要（該当ゼロの報告成果物を作らない）

正本: `docs/planning/review-memory-boundary.md` §3「記録先の適用範囲」「provenance の保持」。

### 5. CI は起動しない（この時点では）

push しても重い CI（`ci.yml`）は起動しない。観点レビューが収束してから最新 HEAD に対して
明示的に起動する（[docs/ai/rules/ci-run.md](../ai/rules/ci-run.md)）。PR 作成時点の検証責務は
ローカルゲート（[verification-gates.md](../ai/rules/verification-gates.md)）が持つ。
