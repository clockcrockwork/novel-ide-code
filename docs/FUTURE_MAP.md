# Future Map（将来構想・機能マップ）

> **MVP 段階の正は [docs/MVP_PLAN.md](MVP_PLAN.md) である。**
> 本ドキュメントは将来構想・候補機能・実装済み基盤・関連 issue の一覧であり、**上から順の実装順ではない**。
> 各項目には MVP 段階の目安タグ（`mvp-alpha` / `mvp-beta` / `mvp-gamma` / `mvp-delta` / `future` / `mvp対象外`）を付すが、
> **段階の確定判断は MVP_PLAN.md が優先する**。AI エージェントはこのファイルを実装優先順位として読まないこと。

実装方針が決まっているが未実装・実装中の機能をまとめる。
各項目は対応する GitHub issue / PR にリンクしている。

## MVP 段階タグの凡例

| タグ | 意味 |
|------|------|
| `mvp-alpha` | MVP Alpha の保証範囲（の subset）。詳細は [MVP_PLAN.md](MVP_PLAN.md) |
| `mvp-beta` | MVP Beta（辞書生成・ローカル校正・フロータイム最小・アプリ内通知） |
| `mvp-gamma` | MVP Gamma（ポモドーロ正式・ブラウザ通知/音・外部 API 校正） |
| `mvp-delta` | MVP Delta 以降（Web Push・Discord・Notion・LLM 校正・矛盾検知） |
| `future` | やる可能性はあるが MVP 段階に割り当てていない将来構想 |
| `mvp対象外` | MVP の保証対象に含めない |

---

## 🔴 モバイル・PWA・IME 対応（#53） — `mvp-alpha`（subset）/ `future`

> Alpha subset（スマホ入力破綻なし / iOS Safari 保存復元 / IME 非干渉 / 仮想キーボード崩壊回避 / 最小キャッシュ・SW）は `mvp-alpha`。
> Web Push・Background Sync 完全対応・高度なインストール導線・アイコン/スプラッシュ完全整備は `future`（Delta 以降）。
> 段階の正は [MVP_PLAN.md「PWA・モバイル・IME 保証範囲」](MVP_PLAN.md#pwaモバイルime-保証範囲239)。**この親 Issue 全体が Alpha 対象ではない。**

**モバイルブラウザからの PWA 利用がメインの使用シナリオ。**
スマートフォン・タブレットでの執筆が PC より主になることを前提に設計すること。

### PWA インストール対応

- [ ] `manifest.json` の整備（アイコン・short_name・display: standalone）
- [ ] Service Worker の導入（オフラインキャッシュ）
- [ ] iOS Safari での PWA インストール対応（`apple-touch-icon` 等）
- [ ] インストールプロンプト UI

### モバイル UI / タッチ操作

- [ ] タッチ操作でのサイドバーモジュール開閉
- [ ] ボトムシート型サイドバー（モバイル向けレイアウト切替）
- [ ] フッタツールバーのモバイル最適化（タップターゲットサイズ確保）
- [ ] ピンチズームの制御（執筆モードでの意図しないズーム防止）
- [ ] バーチャルキーボード表示時のビューポート制御（`visual viewport` API）

### 日本語 IME 対応（TipTap / ProseMirror）

- [ ] 未確定文字（composing 中）への writingRules 適用を抑制する（`compositionstart` / `compositionend` イベント）
- [ ] IME 確定前の中間テキスト表示が ProseMirror の decoration と干渉しないことを確認
- [ ] モバイル IME（フリック入力・音声入力）での動作確認
- [ ] ルビ入力補助（`{ベース|ふりがな}` 記法の入力 UI）

### クロスデバイス同期の PWA 対応

- [ ] オフライン時のキューイング（IndexedDB に溜めてオンライン復帰時に同期）
- [ ] バックグラウンド同期（Service Worker の Background Sync API）

---

## パフォーマンス基盤（メタ #23） — 実装済み基盤（大半 ✅）

大文字数（5 万字超）でのパフォーマンス問題（#37）を解消するための基盤整備。
**実装順序が重要**。土台から順に進める。

| 優先度 | 内容 | issue | 状態 |
|--------|------|-------|------|
| 高 | AppContext の分割 / Zustand store 化 | #24 | ✅ 完了 |
| 高 | localStorage I/O の debounce 化と起動時一括ロード | #25 | ✅ 完了 |
| 中 | 共通仮想化コンポーネント（virtua ベース） | #26 | ✅ 完了 |
| 中 | DiffMode 仮想化（#26 を利用） | #22 | ✅ 完了 |
| 中 | エクスプローラー仮想化（#26 を利用） | #27 | ✅ 完了 |
| 中 | サイドバーモジュール折り畳み時アンマウント | #28 | ✅ 完了 |
| 低 | PreviewMode → パースキャッシュ＋ブロック単位 React.memo | #29 | ✅ 完了 |
| 低 | WriteMode: writingRules の idle 適用 | #30 | ✅ 完了 |

### ベンチマーク（`bench/`）

`bench/` ディレクトリに VirtualList のベンチマークアプリを用意している。
各 issue の before/after 計測に使用する。使い方は [bench/ の issue (#54)](https://github.com/clockcrockwork/novel-ide/issues/54) を参照（✅ #54 完了）。
追加計測シナリオは #81 で管理。

### 方針メモ

- **WriteMode への仮想化は行わない。** ProseMirror の position-based tree と非互換。
- 読み取り専用リスト（DiffMode / FindReplace 結果 / HeadingJump）は `virtua` で仮想化可能。
- 計測なしの最適化は行わない。各 issue で before/after の簡易ベンチを添えること。
- **Preview の描画スキップ**は content-visibility（`.preview-area > div`）で対応済み（#264 / P1-1）。
- **WriteMode 入力レイテンシ**は大ドキュメントの serialize throttle で対応済み（#264 / P1-3）。

### WriteMode 大ドキュメントの描画/スクロール最適化 — `future`（未着手・要 PM ネイティブ手法）

数万行の WriteMode で画面外ブロックの描画/スクロールコストを下げる施策。**CSS `content-visibility` 案は
取り下げ済み**（PR #269 close, 2026-06-14）。取り下げ理由：

- `plainTextToPmJson` は単一改行を `hardBreak`（同一 `<paragraph>` 内）として扱うため、単一改行主体の
  原稿（小説で頻出）は巨大 `<p>` 数個になる。ブロック単位の content-visibility はこの巨大 `<p>` を
  カリングできず、**発火条件を満たす主要ケースで効果が出ない**。
- contenteditable × content-visibility は `coordsAtPos`/`posAtCoords` 破綻・キャレット/選択/IME リスクが高い。
- line 単位カリングには PM 仮想化が必要だが、上記「WriteMode への仮想化は行わない」方針に抵触。

将来検討する場合は、ProseMirror の position-based state と調和する手法（例: 画面外ノードに node decoration やカスタム NodeView を適用して高さを維持しつつ描画を制御するカスタムプラグイン）か、章/シーン単位のファイル分割 UX（#99 系）を前提とする。
いずれも実機（iOS Safari / Android Chrome）での before/after 計測とキャレット/IME/選択の網羅確認が必須。

---

## 検索・本文チェック機能 — `mvp-alpha` — `mvp対象外`（校正系）

> スタイルルールと校正の用語定義は [docs/design/writing-check-policy.md](design/writing-check-policy.md) を参照。
> 段階の正は [MVP_PLAN.md](MVP_PLAN.md)。

### MVP Alpha 対象

| 機能 | 実装 | 状態 |
|------|------|------|
| エディタ内検索 | `src/components/sidebar/FindReplaceMod.jsx` | ✅ 実装済み |
| マーカー・コメント UUID 除外 | 検索対象からアノテーション UUID をフィルタ | 確認要 |
| スタイルルールチェック（Lint 系） | `src/components/sidebar/ProofreadMod.jsx`（簡易）/ 将来の Lint エンジン | 部分実装済み |
| チェック結果のサイドバー表示 | `src/components/sidebar/ProofreadMod.jsx` | 部分実装済み |
| 該当箇所へのジャンプ | — | 未着手 |

スタイルルールチェックの内訳（表記・記法・禁則・文体）の詳細は
[docs/design/writing-check-policy.md](design/writing-check-policy.md) を参照。

### MVP Alpha 対象外（校正系 — Beta 以降）

以下は同一機能エリアに見えるが Alpha に含めない。詳細は下記「校正・品質（#95）」セクションを参照。

- 誤字検出 / 脱字検出 / 衍字検出 / 誤変換検出
- 外部校正 API（Yahoo・Gemini 等）
- AI / LLM 校正

関連: [#258](https://github.com/clockcrockwork/novel-ide/issues/258)（本文チェック機能の再分類）

---

## 校正・品質（#95） — `mvp-beta`（ローカル）/ `mvp-gamma`（外部 API）/ `mvp-delta`（LLM）

> **MVP Alpha では校正を扱わない（校正なし・辞書生成なし・外部 API なし）。**
> 下表のソース／フェーズは実装詳細であり、MVP 段階の正は
> [MVP_PLAN.md「校正・辞書・外部 API 校正の段階」](MVP_PLAN.md#校正辞書外部-api-校正の段階242)。
> ローカルルール＝ Beta、Yahoo/Gemini 等の外部 API＝ Gamma、textlint・LLM 文脈校正＝ Delta 以降。

詳細設計: [docs/proofread/](proofread/)

### ソース

| ソース | 説明 | 実施タイミング | 状態 |
|--------|------|--------------|------|
| ローカルルール | 組み込みルール＋ユーザー定義ルール（正規表現・文字列マッチ） | debounce 自動 / 手動 | 未着手 |
| Yahoo 校正 API | Yahoo! テキスト解析 API（Worker KV でキー管理を推奨・IndexedDB も許容、Worker プロキシ経由） | 手動トリガー | 未着手 |
| Gemini API | Gemini による文体・表現改善（Worker KV でキー管理、Worker プロキシ必須） | 手動トリガー | 未着手 |
| カスタムプロバイダー | ユーザーが任意の OpenAI 互換エンドポイントを追加（Ollama・Groq 等） | 手動トリガー | 将来検討 |
| textlint | `@textlint/script-compiler` による Web Worker 化。日本語ルール群（kuromoji ベース） | 手動トリガー | 将来検討 |

### フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| 1 | proofreadWorker（既存ルール Web Worker 化）＋ debounce 自動トリガー | 未着手 |
| 2 | ProofreadStore（Zustand）＋ ProofreadExtension（背景色ハイライト） | 未着手 |
| 3 | ProofreadMod 刷新（ジャンプ・置換・ソース別タブ・VirtualList） | 未着手 |
| 4 | IndexedDB 永続化（`proofread_results` ストア） | 未着手 |
| 5 | チャンク非同期キュー＋外部 API 向け確認 UI・残量表示 | 未着手 |
| 6 | Cloudflare Worker プロキシ（Yahoo・Gemini）＋ KV ベースのキー管理 UI | 未着手 |
| 7 | Cloudflare KV による校正結果のクロスデバイス同期 | 未着手 |
| 8 | ユーザー定義ローカルルール管理 UI（Git 連携・JSON エクスポート） | 未着手 |
| 9 | カスタム API プロバイダー設定（OpenAI 互換エンドポイント） | 将来検討 |
| 10a | textlint 統合（kuromoji 不要の軽量ルール先行） | 将来検討 |
| 10b | textlint 統合（形態素解析ルール・kuromoji） | 将来検討 |

---

## 通知システム — `mvp-gamma`（ブラウザ通知/音）/ `mvp-delta`（Web Push・Discord）

> **MVP Alpha の通知は Level 0（保存/同期ステータス表示）のみ。** ブラウザ通知・通知音・Web Push は Alpha 対象外。
> 通知レベルの段階定義は [MVP_PLAN.md「通知レベル」](MVP_PLAN.md#通知レベル241)（#241）。
> 既存のポモドーロ通知実装は Level 2 相当の先行実装だが、Alpha では正式対応しない。

### ポモドーロ通知（PR #40 — ✅ マージ済み）

- Web Notification API を使ったローカル通知。
- `src/lib/notify.js` に `createNotifier` / `createLocalPomodoroNotifier` / `ensureNotificationPermission` を実装済み（PR #40）。
- 設定 UI：ポモドーロモジュール内にトグル表示。

### リモートプッシュ通知（将来）

- Web Push（VAPID）を使ったバックグラウンド通知。
- Service Worker 経由で PWA インストール済みのデバイスに通知を送る。
- 環境変数: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（Worker 側）

### その他の通知拡張（#96）

- [ ] 自動保存・同期完了の通知
- [ ] FlowTime セッション終了通知
- [ ] 締め切り・目標文字数達成の通知

---

## ローディング体験改善（#41 — ✅ 完了）

仮想化実装（#23 系）完了後に着手するのが望ましい。

| 場面 | UI |
|------|----|
| サイドバーモジュール | モジュールごとにスケルトンまたはスピナー |
| ファイルロード（未表示ファイル） | プログレスバーまたはスケルトン |
| 全体初期ロード | プログレスバー |
| 執筆エリア（表示済み・追加ロード） | スピナー |

---

## エクスポート拡張（#97） — `mvp-alpha`（TXT/Markdown/JSON 退避）/ `future`（PDF・Notion 等）

> TXT / Markdown / JSON の退避出力は MVP Alpha の安全弁（[#216](https://github.com/clockcrockwork/novel-ide/issues/216)）。
> 縦書き PDF・Notion・その他 CMS・ePub は `future`。

| 形式 | 内容 | 状態 |
|------|------|------|
| PDF（現行） | 横書き PDF | ✅ 実装済み |
| `.txt` | プレーンテキスト出力 | 未着手 |
| 縦書き PDF | 縦書きレイアウトの PDF | 未着手（縦書き対応と連動） |
| Notion | Notion API 経由でページを作成 | 未着手 |
| その他 CMS | WordPress / note 等 API 経由での投稿出力 | 検討中 |
| ePub | 電子書籍形式 | 検討中 |

---

## 複数タイトル・執筆管理（#98） — `mvp-alpha`（最小 UI subset）/ `future`（統計・グラフ）

> 作品・チャプター管理の**最小 UI** は Alpha subset。執筆統計・グラフ・締め切り可視化は `future`（高度なグラフ分析は Alpha 対象外）。

| 機能 | 内容 |
|------|------|
| 複数タイトル管理 | 作品ごとにタイトル・話数・締め切り・執筆ステップ（プロット→下書き→推敲→完成）を管理・可視化 |
| 執筆統計 | 執筆作業時間・文字数増減をグラフで可視化。日次・週次・作品別の集計 |

---

## コンテンツ参照・レイアウト（#99） — `future`

| 機能 | 内容 |
|------|------|
| 分割表示拡張 | 現状の .md 分割表示に加えて、メモ・設定・下書きなどを分割参照できるようにする |
| 縦書き表示 | プレビューモードでの縦書き表示（将来検討予定） |
| 通話/画面共有用カメラ出力 | 執筆配信やオンライン通話での画面共有時にかっこよく見えるカメラ出力用画面 |

---

## 連携・共有（#100） — `mvp-delta` / 外部連携フェーズ

> SNS 共有・Discord 連携・Notion 出力はすべて MVP Alpha 対象外（外部連携フェーズ）。

| 機能 | 内容 | 状態 |
|------|------|------|
| SNS 共有 | 書いた文章の一部を X（旧 Twitter）等に投稿 | 未着手 |
| Discord 連携 | Discord サーバーと連携した執筆進捗管理・称号機能 | 未着手 |
| Notion 出力 | エクスポート参照（上記 #97） | 未着手 |

---

## UX・操作性

### フォルダ操作改善（#36 — ✅ 完了）

- フォルダへのファイル移動が直感的でない問題。
- フォルダ内へのファイル直接作成。
- ドラッグ＆ドロップによるファイル移動を検討。

---

## クロスデバイス同期（#101） — `mvp-alpha`（GitHub 手動 Push/Pull subset）/ `future`（高度同期）

> MVP Alpha は **GitHub リポジトリ経由の最低限の手動 Push/Pull** のみを保証範囲に含める。
> 競合解消 UI・リアルタイム同期・デバイス管理・Worker 高度同期サーバーは `future`。
> 本文を Cloudflare（KV/D1/R2）に永続保存しない方針は [MVP_PLAN.md](MVP_PLAN.md#github-同期cloudflare-worker-最小責務237240) を参照。

### 現状

`worker/` に Cloudflare Worker（Hono）製の同期サーバーがある。
`src/lib/sync.js` から `workerFetch` 経由でファイルを push/pull する。

### 残課題

- [ ] 競合（コンフリクト）解消 UI
- [ ] 同期状態のリアルタイム表示改善
- [ ] デバイス一覧・管理 UI
- [ ] オフライン時キューイング（PWA 対応と連動）

---

## デプロイ方針（未決定）

| 候補 | 利点 | 懸念点 |
|------|------|--------|
| **Cloudflare Pages**（推奨） | Worker・D1・R2 と同一エコシステム。リモート通知との相性が良い | 無料枠の上限要確認 |
| Netlify | 個人利用に向く無料枠 | Cloudflare エコシステムと分離する |

→ PWA・リモート通知・将来の DB 利用を前提とすると Cloudflare Pages が自然な選択。
詳細は [docs/ENVIRONMENT.md](ENVIRONMENT.md) を参照。

---

## GitHub 連携強化（#102） — `mvp-alpha`（最小同期 subset）/ `future`（ブランチ/PR UI）

> Alpha は最低限のファイル単位 Push/Pull のみ。ブランチ切り替え UI・PR 作成/マージ UI は `future`。

現状：`src/lib/github.js` でファイル単位のコミット/プル。

- [ ] ブランチ切り替え UI
- [ ] PR 作成・マージ UI（執筆者向け）
- [ ] 差分を GitHub PR として送る機能

---

## テスト基盤（#103）

- テストランナー：`node --test`（`tests`）
- `tests/markdown.test.js` — markdown パーサーのユニットテスト（Codex 追加）
- Cloudflare Worker 側：テスト未整備（typecheck のみ）→ #65, #75 完了済み
- 今後追加したい：
  - [ ] `src/lib/diffCore.js` のユニットテスト
  - [ ] `src/lib/writingRules.js` のユニットテスト
  - [ ] `eslint-plugin-react` の ESLint 10 対応待ち（`react/jsx-key` 等が追加できない）
  - [ ] サイドバーモジュールのインテグレーションテスト（Vitest 導入も検討）

---

## 取り込み・サイドバーカスタマイズ — `future`

> 旧 issue #172 / #173（トリアージ #536 で close）。実装契機が来た時点で承認フローで個別 issue を起票する。

- [ ] 既存テキスト資産の汎用一括取り込み（txt/md 群の安全なインポート。検証は `validateWorkspaceSettings` / `validatePulledContent` / `validateSafeFileName` を再利用。必須条件 — 拡張子 allowlist・frontmatter 自動確定禁止・取り込み前レビュー UI・本文非改変 — は [INVARIANTS.md §5](data-model/INVARIANTS.md) を正とする）
- [ ] サイドバーモジュールのユーザー管理（追加・削除・並び替え。`*Mod.jsx` + `SidebarBox.jsx` 登録の自己完結構造を前提）

---

## ドキュメントモード・レビューPR運用（将来設計 / #177）

> **MVP対象外**。MVP後に設計・実装する将来機能。詳細は [docs/features/review-workflow.md](features/review-workflow.md) を参照。

[#176](https://github.com/clockcrockwork/novel-ide/issues/176) の「Gitリポジトリ上の可読・再利用可能な創作文書管理方針」を具体化する機能群。

- [ ] **ドキュメントモード** — 本文以外の創作文書（設計カード・スタイルリファレンス・AI指示書等）を Tiptap ベースで編集できるモード
- [ ] **ブロック表示プリセット** — 設計カード・チェックリスト・対比マップ・タイムライン等をパース可能な範囲で便利に表示
- [ ] **原稿単位の作業ブランチ運用** — `work/episode-XXX` 配下で Phase1〜Phase4 を管理する UI（作業中/レビュー中/マージ待ち等として抽象化）
- [ ] **レビューPR運用** — 校正・自動整形・AIレビューを PR として扱い差分とコメントを管理
- [ ] **PRレビューコメント連携** — GitHub PRがある場合はコメントと同期、ない場合はローカルレビューコメントとして成立
- [ ] **レビューコメント基盤** — `manual / proofreading / formatter / style-check / ai-review / checklist-review` を統一的に扱う型定義と基盤実装
