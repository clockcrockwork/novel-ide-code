# コード清掃・リファクタリング方針

このドキュメントは、AI 生成コードの肥大化に対応するための **清掃方針と判断基準** の正本である（#128）。
清掃作業の **手順** は [docs/agent-workflows/code-cleanup.md](../agent-workflows/code-cleanup.md)（skill: `/code-cleanup`）を参照。

清掃は **単発リファクタではなく、仕様変更を伴わない・単位を区切った保守作業** として運用する。
「リファクタして」と都度依頼する方式は判断基準がぶれ、AI が不要な機能変更や過剰抽象化を起こしやすいため、
本ドキュメントで判断基準を固定する。

## 既存規約との関係（重複させない）

清掃の細則は既存ドキュメントが正本である。本ドキュメントは判断基準に集中し、以下を **再掲せずリンク参照** する。

- 責務分離 / DRY（3 箇所以上で共通化検討）/ コメント方針 / 型・境界バリデーション / 過剰ガード禁止 / セルフレビュー項目: [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md)
- 「繰り返し問題 → lint ルール / チェックリスト化」のパイプライン（昇格**優先度** P0/P1/P2 の基準）: [docs/agent-workflows/analyze-pr-history.md](../agent-workflows/analyze-pr-history.md)
- データモデルの不変条件・ルール記述フォーマット: [docs/data-model/INVARIANTS.md](../data-model/INVARIANTS.md)
- 数値定数（閾値）の扱いと自動検証: [docs/PERFORMANCE_THRESHOLDS.md](../PERFORMANCE_THRESHOLDS.md) / `scripts/check-thresholds.js`
- アーキテクチャ境界: [docs/ARCHITECTURE.md](../ARCHITECTURE.md) / [CLAUDE.md](../../CLAUDE.md)

---

## 1. 清掃対象範囲

清掃で扱ってよいのは「挙動を変えずにコードの理解容易性・保守性を上げる」変更のみ。

- lint warning / error の解消
- DRY 化（重複処理の共通化）
- 責務分離（component / hooks / utility / domain logic / store / worker の振り分け）
- UI 責務とデータ処理責務の分離、副作用処理の分離
- 未使用関数・メソッド・変数・ファイルの削除
- 過剰チェック・過剰ガード・過剰な条件分岐の削減
- 記法・命名の統一
- 1 ファイル / 1 関数 / 1 コンポーネントの肥大化解消（分割）
- テストしやすい単位への分割、テスト追加・整理

**対象外（清掃で扱わない）**: 仕様変更・機能追加・UI 変更・パフォーマンス特性の変更・大規模な抽象化や設計変更。
これらが必要になった場合、[PR の単位（REVIEW_GUIDELINES）](../REVIEW_GUIDELINES.md#pr-の単位正本)の分割条件に該当するなら分離し、issue が必要なら承認フローでユーザーへ提示する。

---

## 2. 判断基準

### 2.1 ファイル分割

- 1 ファイルが **2 つ以上の独立した責務** を持ち始めたら分割を検討する（行数より責務を優先）。
- 目安として 1 ファイル **300 行超** は分割候補。ただし機械的に切らず、責務境界で分ける。
- サイドバーツールは `*Mod.jsx` の **自己完結** を維持する（`SidebarBox.jsx` への登録のみで動く構造を壊さない）。
- 分割時は import 経路と公開 API（既存の named export 名）を保つ。利用側の import を最小変更で済ませる。

### 2.2 関数 / コンポーネント分割

- `sonarjs/cognitive-complexity`（`warn=20`）を超える関数は分割候補。`lint` 警告と整合させる。
- コンポーネントが「描画」と「ビジネスロジック」を同時に持つ場合、ロジックを `src/hooks/` か `src/lib/` に切り出す。
- ❌ 1 つの巨大コンポーネントに状態取得・変換・描画・副作用を全部書く
- ✅ 描画は `src/components/`、状態・副作用は `src/hooks/`、純粋変換は `src/lib/` に分離する

### 2.3 配置基準

| 種類 | 配置 | 例 |
| --- | --- | --- |
| UI（描画・JSX） | `src/components/` | `*Mod.jsx`, `EditorBox.jsx` |
| 状態・副作用・React 依存ロジック | `src/hooks/` | `useEditorCommands.js` |
| 純粋ロジック・domain logic（React 非依存） | `src/lib/` | `markdown.js`, `diffCore.js` |
| グローバル状態 | `src/stores/`（Zustand） | `uiStore.js` |
| API / 同期 / 外部サービス連携 | `worker/`, `src/lib/` | `worker/src/index.ts`, `src/lib/sync.js` |
| 型定義（JSDoc `@typedef`） | 対象モジュールと同居、共有時は `src/lib/` | — |

判断に迷う場合は [docs/ARCHITECTURE.md](../ARCHITECTURE.md) と [CLAUDE.md](../../CLAUDE.md) の境界定義を正とする。

### 2.4 未使用コード削除

削除は **参照 0 件を確認してから** 行う。削除自体が挙動に影響しうるため慎重に扱う。

- `git grep` 等でプロジェクト全体を検索し、参照が **0 件** であること（`eslint` の `no-unused-vars` はファイル内ローカル変数のみを対象とするため、export されたコードの検出には `git grep` や将来導入する `knip`（#250）を使用する）。
- export されている場合、テスト・他モジュール・動的 import（`import()` / 文字列キー参照）からの利用が無いことを確認する。
- ❌ 「使ってなさそう」で削除する
- ✅ 参照検索 0 件 + テスト経由でも未使用を確認してから削除する
- 公開 API（worker のエンドポイント・ストアの公開メソッド等）は、外部デバイス・他セッションからの利用を考慮し、安易に削除しない。

### 2.5 defensive coding と過剰チェックの線引き

- ガードを置くのは **システム境界**（IndexedDB・外部 API・ユーザー入力・不定状態）のみ。内部コードは信頼する。
- 「安全そう」を理由にした内部の null チェック乱用は **過剰ガード** として削減対象。
- 詳細は [REVIEW_GUIDELINES.md「型・バリデーション」](../REVIEW_GUIDELINES.md#型バリデーション) を正とする。

### 2.6 コメント

- 原則コメントなし。命名で意図を伝える。残す/削る基準は [REVIEW_GUIDELINES.md「コメント」](../REVIEW_GUIDELINES.md#コメント) を正とする。
- 清掃時は、コードと乖離した古いコメント（「〜を truncate するため」等）を **削除または更新** する。

---

## 3. 確認コマンド

清掃の前後で以下を実行し、挙動非変更を担保する。

| コマンド | 用途 |
| --- | --- |
| `npm run lint` | ESLint（custom rule 17 件含む） |
| `npm run test` | vitest + node --test の両ランナー |
| `npm run check` | `lint` + `check:thresholds` + `test` の一括実行 |
| `npm run build` | 構造変更時のビルド確認 |
| `npm run test:e2e` | 入力経路・UI を触る場合（`@heavy` 除く） |

清掃 PR は最低でも `npm run check` を通すこと。

---

## 4. 静的解析ツールの評価と段階導入計画

清掃ルールのうち自動検出できるものは lint / 静的解析へ寄せる。ただし **最初から厳格化せず warning / report から開始し、必要なものだけ error 化** する。

以下は **評価結果と導入計画** である。未導入ツールの導入は、必要になった時点で承認フロー（[REVIEW_GUIDELINES「issue の作成・close」](../REVIEW_GUIDELINES.md#issue-の作成close承認フロー正本)）で issue 化を判断する。

| 観点 | 候補ツール | 現状 | 導入方針 | npm script 候補 |
| --- | --- | --- | --- | --- |
| 未使用 export / ファイル / 依存 | `knip` | 未導入 | warn レポートから開始。CI は非 fail で運用し、削除は人/AI が確認 | `analyze:unused` |
| 重複コード検出 | `jscpd` | 未導入 | しきい値レポートから開始。3 件以上の重複を共通化候補として可視化 | `analyze:duplicates` |
| 循環依存検出 | `dependency-cruiser` | 未導入 | まず report のみ。循環を 0 維持する error 化は安定後 | `analyze:deps` |
| 複雑度 / 最大行数 | ESLint built-in（`complexity` / `max-lines` / `max-lines-per-function`） | 未設定（`sonarjs/cognitive-complexity` `warn=20` のみ） | warn で追加し、既存違反の解消後に閾値調整 | （lint に統合） |
| フォーマット統一 | **`prettier`**（採用） | 導入済み（PR-A）/ 一括整形は PR-B | 設定 PR と一括整形 PR を分離。`eslint-config-prettier` で整形系を ESLint から外し責務分離 | `format` / `format:check` |

**フォーマッタ選定（#254）**: `prettier` を採用。本リポジトリは 17 件の custom ESLint ルール（セキュリティ/バグ検出の AST セマンティック）に深く依存しており、整形だけを担う純フォーマッタが責務分離上最適。ESLint 側の整形系ルールは `linebreak-style` のみで、`eslint-config-prettier` を flat config 末尾に置くことで無効化され衝突しない。`biome` は統合 lint が主利点だが custom ルールを再現できず、formatter 専用利用では利点を活かせないため見送り。スコープは js/jsx/css（worker は独立 TS 構成のため対象外、docs md/json も対象外）。

導入時の共通方針:

- 既存の `npm run check` を壊さない（新ツールは独立スクリプトで追加し、安定後に `check` へ統合）。
- ツール導入と検出違反の修正は同一 PR に含めてよい（提供結果「ツール X の導入と違反解消」として自己完結する場合）。修正量が大きく独立検証が必要な場合のみ分割する。
- error 化は「既存違反 0 件」かつ「開発速度を落とさない」と判断できてから。

---

## 5. PR 単位

PR の単位は [REVIEW_GUIDELINES「PR の単位」](../REVIEW_GUIDELINES.md#pr-の単位正本) を正とする（**1 PR = 1 つの自己完結した提供結果・検証単位・ロールバック単位**。変更種別だけでは分割しない）。清掃固有の規則は次の 2 点のみ:

- 清掃（挙動非変更）と挙動変更は、意図しない仕様変更をレビューで検出できるよう **提供結果として混ぜない**（提供結果が「機能 X の実装」でその過程の旧コード削除・整理を含むのは可。「清掃のついでに挙動を変える」は不可）。
- PR 本文に **「挙動変更: あり / なし」** を必ず明記する。

清掃対象はコードに限らない。docs・ワークフロー文書の重複・陳腐化の解消も同じ判断基準（挙動＝規則の意味を変えない・提供結果単位）で清掃として扱う。
