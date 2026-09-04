# PR作成前 最終確認チェックリスト

PR を作成する直前に確認する。[docs/agent-workflows/pre-commit-review.md](../../agent-workflows/pre-commit-review.md) のセルフレビュー手順を完了した後に使う。

---

## 要求との整合

- [ ] Issue / タスクの要求内容のみを変更しているか
- [ ] 要求外の変更・「ついで修正」が混ざっていないか
- [ ] 既存仕様を勝手に変更していないか

## ground truth 確認

- [ ] 作業開始前に [MVP_PLAN.md](../../MVP_PLAN.md) / [INVARIANTS.md](../../data-model/INVARIANTS.md) / [ARCHITECTURE.md](../../ARCHITECTURE.md) を確認したか
- [ ] [リスクモデリング表](../../agent-workflows/risk-modeling.md)を作成・確認したか（skip した場合は理由を PR 本文に明記する）
- [ ] [既存実装調査表](../../agent-workflows/codebase-recon.md)を実装着手前に作成したか（実行した検索クエリ・再利用/準拠/新規の判断が残っているか）

## 品質ゲート

- [ ] npm run lint が通っているか
- [ ] npm run test が通っているか
- [ ] [/pre-commit-review](../../agent-workflows/pre-commit-review.md) を完了したか（lint / test / 観点別レビュー[review-angles](../../agent-workflows/review-angles/README.md) / security-review）
- [ ] 高リスク領域（editor / persistence / GitHub sync / Worker / security boundary / export-import / 性能）に触れる場合、[second-opinion-review.md](../../agent-workflows/second-opinion-review.md) を**実施して記録を PR 本文に含めた**、または**任意運用のため見送り、その理由を PR 本文に記録した**か（該当しなければ N/A。現状は任意運用の試行フェーズであり、未実施そのものは不可としない）

## anti-skip 確認

- [ ] 「小さい変更だから検証不要」でスキップしていないか
- [ ] 「既存に合わせたから確認不要」でスキップしていないか
- [ ] 「ドキュメントのみだから lint / test 不要」でスキップしていないか
- [ ] テスト必須カテゴリ（文章変換 / セキュリティ境界）に該当するコードに新規テストを追加したか（テストがない領域でも「追加不要」と即断しない）
- [ ] リスクモデリングを「自明だから不要」でスキップしていないか
- [ ] agent-memory のライフサイクル操作（`promote` / `reject` / `retire` / `supersede` / `purge`、および作業ブランチ外の `revise`）を含む場合、対応する `Memory-Endorsement:` trailer を**コミットメッセージへ転記したか**（CLI が強制するのはフラグの指定までで、転記漏れは機械検出されない。`docs/planning/agent-memory-design.md` §6.0）

## PR 本文

- [ ] 提供結果（必要な理由を含む）・最終的な変更が書かれているか（構成の正本: [create-pr.md](../../agent-workflows/create-pr.md)）
- [ ] コード変更 PR の場合、「完了条件」「想定ケース」「既存実装調査」「証拠表」「レビューループ記録」と関連 issue 参照（`closes #番号` / `refs #番号`、なければ「関連issue: なし（理由）」）が書かれているか（`npm run check:artifacts -- --body-file <下書き>` でローカル確認。[evidence-check.md](../../agent-workflows/evidence-check.md)「機械的下限ゲート」）
- [ ] 証拠表の ✅ / `[x]` に検証可能な証拠（ファイル:行・テスト名・実行結果）が付いているか（「N/A」「確認済み」は証拠ではない）
- [ ] レビューループ記録に収束宣言（「収束」単独セル、または上限超過時の「残所見」列挙）があるか
- [ ] リスクモデリングをスキップした場合、理由が PR 本文に書かれているか
- [ ] ルール変更の影響（対象 Issue / 遡及対応要否）が書かれているか（ドキュメント変更 PR の場合）
