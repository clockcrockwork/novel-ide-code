# コード清掃・リファクタリング手順

> **Ground truth:** [docs/maintenance/code-cleanup.md](../maintenance/code-cleanup.md)（判断基準）/ [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)（セルフレビュー項目）
> **Entry gate:** 清掃の提供結果（何がどう良くなるか）を1つ定め、現行の責務・公開API・呼び出し元を把握するまで着手しない
> **Required artifacts:** 整理方針の箇条書き、削除した未使用の参照0件確認、「挙動変更: なし」の明記
> **Verification gate:** `npm run check`（lint + check:thresholds + test）/ `npm run build`（構造変更時）。[docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照。`eslint-disable` でのエラー抑制・参照確認なしの削除は禁止
> **Cost note:** 仕様変更を混ぜると清掃PRが挙動回帰の原因になり、レビュー単位が崩れる

引数: 清掃対象（ファイル / 機能 / ディレクトリ / lint カテゴリ）。省略時はユーザーに対象範囲を確認する。

AI エージェントが **仕様変更を伴わずに** コードを清掃・整理するための作業手順。
判断基準（分割・削除・配置・過剰ガードの線引き）は [docs/maintenance/code-cleanup.md](../maintenance/code-cleanup.md) を正本とする。
セルフレビュー項目は [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) を正本とする。

## 作業単位（提供結果単位）

1 PR = 1 つの自己完結した提供結果（[REVIEW_GUIDELINES「PR の単位」](../REVIEW_GUIDELINES.md#pr-の単位正本) を正とする）。清掃では「対象範囲 X をどう良くするか」を 1 つの提供結果として定め、その達成に必要な変更（重複解消・未使用削除・分割・テスト追加・記法統一など）は **同一 PR に含めてよい**。変更種別（削除のみ / テストのみ 等）で機械的に分割しない。分割するのは提供結果として独立に検証・ロールバックしたい場合のみ。

範囲は一度に把握・検証できる大きさに保つ（1 機能・1 ディレクトリ程度が目安。リポジトリ全域の一括修正はしない）。対象はコードに限らず、docs・ワークフロー文書の清掃も同じ手順で扱う。

## 禁止事項

- 仕様変更・機能追加・UI 変更を清掃の提供結果に混ぜる
- 参照確認なしの削除
- 要求外の「ついで修正」（提供結果に含まれない変更）
- 先回りの過剰抽象化・汎用ユーティリティの新設
- `eslint-disable` でのエラー抑制（根本修正かルール設定変更で対応する）
- テストの削除やスキップ（`test.skip` や `it.skip` 等）によるエラーの一時的な回避

## 手順

### 1. 対象範囲と提供結果を確定する

清掃の提供結果を 1 つ定め、対象ファイル / ディレクトリを確定する。範囲外には触れない。

### 2. 既存挙動を把握する

対象コードを読み、現行の責務・公開 API・呼び出し元を理解する。推測で実装しない。

```bash
# 呼び出し元・参照を確認（例: git grep "targetFunctionName"）
# （未使用判定は [docs/maintenance/code-cleanup.md](../maintenance/code-cleanup.md) 2.4 に従う）
```

### 3. 現状を確認する

清掃前のベースラインを取る。

```bash
npm run check
```

### 4. 整理方針を箇条書きで提示する

着手前に「何を・なぜ整理するか」を箇条書きで出す。判断基準は code-cleanup.md を参照。

### 5. 挙動変更あり / なしを分離する

清掃の提供結果に挙動変更を混ぜない。挙動変更が必要と分かった場合は、[承認フロー](../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本)で issue 候補としてユーザーへ提示するか、ユーザーと合意のうえ提供結果を「挙動変更あり」の PR として仕切り直す。

### 6. 未使用コードは参照検索後に削除する

`git grep` 等でプロジェクト全体を検索し、参照 0 件を確認してから削除する（`eslint` の `no-unused-vars` はファイル内ローカル変数のみを対象とするため、export されたコードの検出には `git grep` を使用する）。
export はテスト・動的 import 経由の利用も確認する（[docs/maintenance/code-cleanup.md](../maintenance/code-cleanup.md) 2.4）。

### 7. ファイル分割時は import 経路と公開 API を確認する

既存の `named export` 名を保ち、利用側 `import` の変更を最小化する。また、`*Mod.jsx` の自己完結を崩さない。

### 8. テストを追加 / 更新する

分割・整理で影響する範囲のテストを追加・更新する。古いテスト名・コメントは現状に合わせる。
「revert すると fail するか」を意識する（REVIEW_GUIDELINES「テスト」項目）。

### 9. 一括チェックを実行する

```bash
npm run check   # lint + check:thresholds + test
npm run build   # 構造変更時
```

### 10. PR 本文に「挙動変更: あり / なし」を明記する

提供結果・対象範囲・削除した未使用・追加テスト・`npm run check` 結果を記載する。

## 完了報告テンプレ

```markdown
## コード清掃 完了

- 提供結果: （この清掃で何がどう良くなったか 1 行）
- 対象範囲: （ファイル・ディレクトリ）
- 挙動変更: なし
- 削除した未使用: （関数・ファイル名と参照0件の確認方法）
- 追加 / 更新テスト: （ファイル名）
- check 結果: `npm run check` pass / fail
```
