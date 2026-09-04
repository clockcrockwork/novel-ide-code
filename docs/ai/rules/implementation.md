# 機能実装・バグ修正ルール

機能実装およびバグ修正タスクに着手する前と完了後に参照する。

---

## 作業開始前 — ground truth の固定

「何を基準に実装するか」を着手前に確定する。不明なまま実装を始めると、推測で埋めた仕様が混入する。

### 確認する正本（ground truth）

| 正本 | 確認内容 |
|------|---------|
| [docs/MVP_PLAN.md](../../MVP_PLAN.md) | 対象フェーズ（Alpha/Beta/Gamma/Delta）の定義・対象範囲 |
| [docs/data-model/INVARIANTS.md](../../data-model/INVARIANTS.md) | 変更対象ファイルの不変条件（kind判定・DB操作・入力検証） |
| [docs/ARCHITECTURE.md](../../ARCHITECTURE.md) | 責務分担・状態管理・永続化パターン・エディタ構造 |

implementer サブエージェントとして起動された場合は、上記に加えて**承認済み計画**を ground truth とする（内訳・入出力契約の正本: [subagent-roles.md](../../agent-workflows/subagent-roles.md) の implementer 行）。

### 不明点の扱い

確認してもなお不明な仕様は「未確認事項」として PR 本文に明示する。推測で補完しない。

---

## 作業開始前 — 必須 artifact の作成

着手前に以下を揃える。

### 完了条件チェックリスト

[docs/agent-workflows/requirement-probe.md](../../agent-workflows/requirement-probe.md) の手順に従い、依頼・issue に明文化されていない要件（UI/UX・データ保護・失敗時挙動等）を洗い出し、「これがないと PASS できない」条件を検証方法付きで確定する。

### リスクモデリング表

[docs/agent-workflows/risk-modeling.md](../../agent-workflows/risk-modeling.md) の手順に従い、想定ケース表を作成する。

- 正常系 / 不正・異常入力 / 外部状態変化 / 非同期・並行 / データ永続化 / UI失敗 を洗い出す
- 対応するもの・見送るもの（理由付き）を分類する
- **「全部対応する」でも「全部省略する」でもなく、一旦全部上げてから採否判断する**

### 既存実装調査表

[docs/agent-workflows/codebase-recon.md](../../agent-workflows/codebase-recon.md) の手順に従い、コードを書き始める前に現行コードベースを検索する。

- 類似機能 / 再利用候補 / 慣習サンプル / 影響箇所 / 過去の経緯 の 5 カテゴリを最低 1 クエリずつ検索し、実行したクエリを記録する
- 再利用 / 拡張 / 準拠 / 新規 の判断を理由付きで調査表に残す
- **新規の util / component は「探して無かった」検索記録付きでのみ作成する**

### 変更対象ファイルと影響範囲の一覧

- 変更するファイルと各ファイルの責務（既存実装調査の「影響箇所」ヒットを反映する）
- 影響する状態管理・永続化・UI・テストの範囲

---

## 実装中の原則

- 要求された内容のみを変更する。「ついで修正」を混ぜない
- **最小実装**: 承認済み計画の完了条件を満たす最小の変更だけを行う。計画にない防御コード・リファクタ・命名変更・抽象化・docs 追記や、要求外の機能・仕組みに対するテストを自発的に足さない（修正が閉じる failure scenario を固定する regression test は最小実装に**含まれる**。[pre-commit-review.md](../../agent-workflows/pre-commit-review.md) ステップ6 の昇格判断に従う）（「将来のため」「念のため」「ついでに堅くする」は足す理由にならない。足したものはそのまま次のレビュー対象になり、周回を増やす）
- レビュー所見への対応は、orchestrator が**「採用」と明記した項目だけ**を実装する。所見一覧を渡されても未採用の項目・「参考」に分類された項目は触らない（採用基準の正本: [review-angles/finding-criteria.md](../../agent-workflows/review-angles/finding-criteria.md)）
- 実装中に気づいた改善点・欠陥候補・別の仕組みの強化案は変更せず、報告の「発見事項」に列挙して返す（起票も修正もしない）
- 1 回の移譲で扱う対応項目には上限がある（値の正本は [subagent-roles.md](../../agent-workflows/subagent-roles.md) の orchestrator 裁定規則）。超える指示は分割を求める（項目が増えるほど verification gate が赤で戻る率と、修正が持ち込む回帰が増える）
- 仕様が不明な箇所を推測で補完しない（PR本文・Issue に「未確認事項」として残す）
- 既存処理を読んでから実装する。現行実装を読まずに推測で書かない（正本: [codebase-recon.md](../../agent-workflows/codebase-recon.md)。調査表は着手前に作成済みであること）
- 実装中に新しい関数・ファイル・依存を作ると決めた時点で、その対象について既存実装調査（必須検索セット）を再実行し調査表に追記する
- kind 判定は `hasFlag` 経由。`kindId` の直接比較は禁止（[INVARIANTS.md](../../data-model/INVARIANTS.md)）
- IDB 書き込みは適切に await する
- Zustand はセレクター経由で購読する（全ストア購読は禁止）

---

## 実装完了後 — verification gate

以下をすべて通過してから PR を作成する。

- [ ] npm run lint が通っている
- [ ] npm run test が通っている
- [ ] テスト必須カテゴリ（文章変換 / セキュリティ境界）に新規テストを追加した（対象外の場合は理由を記録する）
- [ ] [/pre-commit-review](../../agent-workflows/pre-commit-review.md) を完了した（観点別レビュー[review-angles](../../agent-workflows/review-angles/README.md) / security-review を含む）
- [ ] [evidence-check.md](../../agent-workflows/evidence-check.md) に従い、完了条件・想定ケース・TODO の証拠検証を行った（証拠表を PR 本文に残す）。`npm run check:artifacts` の機械的下限ゲートを通過している
- [ ] [docs/ai/checklists/pre-pr.md](../checklists/pre-pr.md) のチェックリストをすべて確認した

---

## anti-skip rule

以下の理由でのスキップは禁止する。発見した場合は実施してから次に進む。

| スキップ理由（禁止） | 正しい対応 |
|-------------------|-----------|
| 「小さい変更なので検証不要」 | 変更規模に関わらず lint / test / pre-commit-review を実施する |
| 「既存に合わせたので確認不要」 | 既存コードが正しいとは限らない。ground truth を確認する |
| 「ドキュメントのみなので lint / test 不要」 | `npm run lint` は `.md` 対象外だが確認手順は省略しない |
| 「テストがない領域なので追加不要」 | テスト必須カテゴリに該当するか確認してから判断する |
| 「リスクモデリングは自明なのでスキップ」 | 自明でも表を作成して「自明と判断した理由」を残す |
