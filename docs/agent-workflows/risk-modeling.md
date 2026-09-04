# 実装前リスクモデリング（想定ケース洗い出し）

> **Ground truth:** Issue 本文 / 実装計画 / [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) / 過去レビュー指摘（`docs/pr/PR-*.md` と `docs/pr-analysis/items.json`）
> **Entry gate:** 変更予定ファイル・領域を把握し、領域別リスク表（手順2）と PR履歴パターン（手順2.5）を引くまで実装に進まない
> **Required artifacts:** 想定ケース表（対応するもの / 見送るもの＋理由 / 不正系テスト計画）を実装計画・作業メモ・PR本文に残す
> **Verification gate:** 変更種別に応じたゲート → [docs/ai/rules/verification-gates.md](../ai/rules/verification-gates.md)
> **Anti-skip:** [docs/ai/README.md](../ai/README.md)「anti-skip rule」を参照（「リスクモデリングは自明なのでスキップ」は禁止。自明でも表を作り理由を残す）
> **Cost note:** 省略すると、実装後のレビューで「〇〇の場合がある」系の後追い指摘が増え、手戻りが発生する

実装開始前または実装計画作成時に、対象作業で想定すべき不正パターン・異常系・外部状態変化を**強制的に一度すべて洗い出し**、対応するもの・見送るものを理由付きで分類する工程。

PRレビューで初めて発見される正当な「〇〇の場合がある」系指摘を減らし、レビューを「漏れ確認・妥当性確認」へ寄せることが目的（`docs/pr/PR-*.md` に、本来は実装前に想定できた null/undefined ガード・stale state・GitHub API 異常系・IDB 破損データ・SSRF/トラバーサル・ProseMirror 文書構造などの後追い指摘が多数蓄積している）。

## 原則

- **「全部ガードする」ではなく「一旦全部想定に上げて採否判断する」**。想定の網羅と対応の取捨は別工程。
- 発生しないと判断する場合も、**想定不要・対応不要の理由を残す**（黙って落とさない）。
- GitHub正本・同期・IDB・Tiptap/ProseMirror 文書モデル・長文本文は**広めに想定する**。GitHub 側のリポジトリ状態やユーザーによるデータ変更は「想定外」ではなく通常運用上の入力。
- 実装時点では、**不正系・異常系テストの追加を優先候補**として扱う。
- 機械的に判定できるものは lint / test / CI / スクリプトへ寄せる。判定できないものを本ワークフロー（計画テンプレート・チェックリスト）で補助する。

## 呼び出しタイミング

- **pick-issue 経由**: issue 選定後、実装計画にこの想定ケース表を含める（`pick-issue.md` 手順5を参照）。
- **pick-issue を介さない作業**: 実装着手前に本ドキュメントの手順に従い、想定ケース表を作業メモまたは PR 本文に残す。
- **plan モード**: コード変更を含む計画は、plan 本文に想定ケース表を埋めるか `/risk-modeling` の実行を実装前工程として明記する。ExitPlanMode 時に `scripts/agent/hooks/check-plan-gates.js` が機械検査する（fail-open。最終防衛線は PR 段階の `artifacts-gate`）。
- **コミット/PR 前**: 想定ケース表が作られ「今回対応しないもの」に理由が付いているかを `pre-commit-review.md` / `create-pr.md` で確認する。

## 手順

### 1. 変更予定ファイル・領域の把握

issue 本文・実装計画・`git diff`（または変更予定ファイルの想定）から、触れる領域を洗い出す。

### 2. ファイル/領域別チェック観点の参照

変更予定ファイルのパス・拡張子から、想定すべきケースの**候補**を引く。提示はあくまで候補であり、最終的な採否は手順3の表に理由付きで記録する（パスだけで過剰な想定を増幅しないこと）。

| 領域 / パス例 | 想定すべきケース候補 |
|---|---|
| `src/lib/tiptap/**`, `src/components/editor/**`, `src/lib/styleRules/**` | Tiptap/ProseMirror 文書モデル。paragraph / hardBreak / ruby / slashComment / inlineComment / mark / Decoration / PM position。`doc.textContent` と正本テキスト・表示テキストの差異。stale result（古い座標・旧ファイル結果の残留） |
| `src/lib/db.js`, `src/stores/**` | IndexedDB に旧形式・壊れた形式・途中保存データが残る。hydrate 順序。migration。pending write / flush 漏れ。malformed persisted data。世代/シーケンス invariant（seq/generation/savedSeq）を進める/据え置く**全 call site**（呼び出し側の保存経路。§非同期・競合 参照） |
| `worker/src/**`, `src/lib/github/**`, `src/lib/sync.js` 系 | GitHub API。401 / 403 / 409（競合）/ 5xx。stale SHA。pagination。path traversal（空セグメント含む）。body size。レート制限。ユーザーが GitHub 側で直接編集・削除・ブランチ/権限変更 |
| `src/components/**Modal.jsx`, `src/components/sidebar/**` | 失敗したのに成功扱い。エラーが空状態として表示される。stale display。focus / close timing。複数ダイアログ・selector 重複 |
| [verification-gates.md](../ai/rules/verification-gates.md)「モバイル viewport / iOS キーボード」行のトリガー集合（正本。列挙はここに複製しない）に該当する変更 | モバイル viewport（`100dvh` と `#root` 縮小の乖離・iOS キーボードによる下部 UI 隠れ・`visualViewport` 縮小への追従。PR #167 の回帰クラス）。計画時に予見せず実装中に該当が判明した場合は表へ戻って追記する |
| `plainText` / `styleRules` / serializer 系（`src/lib/plainText.js` 等） | roundtrip（シリアライズ→再パース）。CRLF。コメント・ruby・空 token。O(N²)。文境界。Unicode / surrogate pair / 不可視文字 |

### 2.5. PR履歴由来リスクパターンの照合

手順2で引いた領域に対し、過去のPRレビューで繰り返し指摘されたパターンを**実装前に**照合する（後追い指摘の予防）。

- `node scripts/analyze-pr-history.js --save` が生成する `docs/pr-analysis/risk-patterns.json` を、変更予定ファイルの領域（`primary_area`。語彙は `docs/planning/pr-history-schema-design.md` §3.1）で引く（#353）。
- 引いた領域の `risk_cases` を「想定ケース表へ上げる候補」とし、`followups`（follow-up-needed / requires-design 系の見送り）は同領域の実装時に必ず再検討する。
- **`risk-patterns.json` の領域集計が空（curated 0 件）でも「リスクなし」を意味しない**。その場合は従来どおり `docs/pr-analysis/items.json` / `detailed-items.json` と `docs/pr/PR-*.md` を直接照合する（カテゴリ分類は [analyze-pr-history.md](analyze-pr-history.md) 参照）。
- 代表パターン（手順2の表と対応）:
  - **Tiptap / ProseMirror**: hardBreak / paragraph boundary / PM position / ruby / slashComment / inlineComment
  - **GitHub同期**: stale SHA / GitHub側での直接編集・削除 / 401·403·409·5xx / malformed persisted data
  - **本文処理**: long text / Unicode surrogate pair / 不可視文字 / O(N²)
- 該当カテゴリで過去に指摘がある観点は、手順3の表に「上げる」候補として必ず含める（落とす場合も理由を残す）。

### 3. 想定ケース表の作成

以下のテンプレートを実装計画（PR 本文または作業メモ）に埋める。**各カテゴリは「上げてから落とす」**。落とす場合は理由を必ず書く。

**⏭️「今回対応しない」判断は結論ではなく前提つきで書く。** 各項目に「前提（＋任意で失効条件）」を添え、依存する外部状態を名指しする（「前提: X が Y である限り不要」）。前提のない ⏭️ は後続の設計変更・受理文法の変更でいつ無効化されたか追跡できず、🔁（既判断）で誤って永続保護される（PR #396 #36 の実例）。書式・波及セルフレビューの正本は [review-pr.md](review-pr.md) ステップ4・6.5、一般原則は [skill-design-rubric.md](skill-design-rubric.md)。

```md
## 想定ケース

### 正常系
- ...

### 不正・異常入力
- null / undefined / 空文字 / malformed data / 不正JSON / 不正ファイル名 など

### 外部状態変化
- GitHub側でファイル・ブランチ・SHA・権限・内容が変化する
- ユーザーがGitHub側で直接データを編集・削除する

### 非同期・競合
- 別タブ・別デバイス・同期中操作・timer/pagehide・async後の stale state
- **〔世代/シーケンス invariant の発火条件・記録書式・照合範囲の正本 — angle-adversarial / angle-riskmodel は本項目を参照し複製しない〕** モジュールが単調な**世代/シーケンス invariant**（seq / generation / version / savedSeq 等）を公開する変更、または**invariant 定義自体は unchanged でも既存 invariant の呼び出し元（call site）だけを追加・移動・削除する変更**（`noteDirty`/`noteReset` 呼び出しの変更等）では、それを**読む/進める/据え置く全 call site を列挙**して照合する（ガード本体のモジュール内観測だけでは、呼び出し側の状態遷移経路が invariant を更新しない cross-module 盲点を取りこぼす。PR #434 で自前4系統が3周収束宣言後、外部レビューが呼び出し側の世代進行漏れで実バグを反復検出）。列挙は**この `### 非同期・競合` カテゴリ配下の項目**として `ファイル:関数` の一覧で記録する（書式: `{invariant名} — 進める: {ファイル}:{関数} ／ 読む: {ファイル}:{関数} ／ 据え置き: {ファイル}:{関数}（据え置きの理由1行）`。列挙対象と照合範囲は**実行時ソース**〔`*.test.js`・`*.spec.js`・`docs/` 配下の言及は数えない〕で、識別子はリポジトリ grep の実 call site と一致させる — angle-riskmodel がこの範囲の grep で照合する）— セクション外（作業メモの散文等）はレビュー時（angle-riskmodel）に「列挙あり」と数えられない

### データ保持・永続化
- IndexedDB に旧形式・壊れた形式・途中保存データが残る
- pending write / flush 漏れ / hydrate順序の問題

### Tiptap / ProseMirror 文書構造
- paragraph / hardBreak / ruby / slashComment / inlineComment / mark / Decoration / PM position
- doc.textContent と正本テキスト・表示テキストの差異

### 長文・性能
- 5万字以上・多数ファイル・O(N²)・大容量文字列・Unicode / surrogate pair / 不可視文字

### 表示・UX失敗
- 失敗したのに成功扱い
- エラーが空状態として表示される
- 古い結果・古い座標・旧ファイル結果が残る

## 今回対応するもの
- ...

## 今回対応しないもの
- {ケース} — 前提: {この外部状態 X がこうである限り不要} ／ 失効条件: {X が変わったら見直す（任意）} ／ 理由: {MVP範囲外 / 現コールサイトでは発生しない / 承認済み issue #N で扱う / 先に設計が必要 など。「別 issue で扱う」と書く場合は承認フローで提示済みであること}

## 不正系テスト計画
- 追加する単体テスト
- 追加するE2E/統合テスト
- 今回追加しない場合の理由
```

### 4. 不正系テストの優先検討

「今回対応するもの」のうち、不正・異常入力／外部状態変化／非同期・競合に該当するものは、**単体テスト・E2E/統合テストの追加を最優先候補**として検討する。追加しない場合は「不正系テスト計画」に理由を残す（`docs/REVIEW_GUIDELINES.md` の「テスト」項目と整合）。

## 将来の機械化（実装はこのPR範囲外）

このワークフローは「機械的に判定できないもの」を人手で補助する位置づけ。以下は将来スクリプト/スキルへ移せる責務として明記しておく：

- **ファイルパス → 候補提示**: 変更予定ファイル一覧から手順2の表を自動で引く `scripts/suggest-risk-cases.js`（候補）。
- **PR履歴カテゴリ照合**: #353 段階Bで `docs/pr-analysis/risk-patterns.json`（`primary_area` 別集計）が生成されるようになった。残る機械化は「変更予定ファイル一覧 → `primary_area` の自動推定 → 該当領域の `risk_cases` 提示」の接続部分と、curation（段階C）による `risk_cases` の充足。

機械化したカテゴリは本ワークフローのチェック項目から外し、lint / test / CI へ格上げしていく（`docs/REVIEW_GUIDELINES.md` の「lint / 自動化観点」と同方針）。

## 関連

- [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) — 開発・レビュー方針（実装前の想定ケース節 / テスト必須カテゴリ）
- [docs/agent-workflows/pick-issue.md](pick-issue.md) — issue 選定後に本工程を実装計画へ含める
- [docs/agent-workflows/pre-commit-review.md](pre-commit-review.md) / [docs/agent-workflows/create-pr.md](create-pr.md) — 想定ケース表の有無を確認
- [docs/agent-workflows/analyze-pr-history.md](analyze-pr-history.md) / `scripts/analyze-pr-history.js` — 過去レビュー指摘のカテゴリ分類（将来の機械化元）
