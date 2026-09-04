# MVP 計画（段階定義の正典）

> **このドキュメントが MVP 段階定義の唯一の正（source of truth）である。**
> MVP Alpha / Beta / Gamma / Delta の保証範囲・対象外スコープは、すべてここを基準とする。
> 関連 Issue: [#237](https://github.com/clockcrockwork/novel-ide/issues/237)（本定義の親 Issue）

## AI エージェントへのガード（最重要）

このプロジェクトは現在 **MVP Alpha** を運用テストとして立ち上げる段階にある。
作業対象を選ぶ・実装する・レビューするときは、次を厳守すること。

- **`docs/FUTURE_MAP.md`（旧 ROADMAP.md）を実装順として読まない。** あれは将来構想・候補機能・実装済み基盤の一覧であり、上から順に着手すべき優先順位ではない。
- **MVP Alpha に以下を混入させない**：辞書生成 / ローカル校正 / 外部 API 校正 / LLM 校正 / フロータイム実装 / ポモドーロ正式対応 / ブラウザ通知・通知音 / Web Push / Discord・Notion・SNS 連携 / 高度なグラフ分析。
- **MVP Alpha は Local-only ではない。** 主導線は「ローカルファースト + GitHub 主導同期」。GitHub 未接続は主導線ではなく、本文喪失・作業不能を避けるための**退避モード（安全弁）**として扱う。
- 各機能がどの段階に属するか迷ったら、まずこのドキュメントの段階表を見る。表に無い場合は実装せず Issue に残す。

---

## 段階の全体像

| 段階 | テーマ | 目的の核 |
|------|--------|----------|
| **MVP Alpha** | ローカルファースト執筆基盤 | スマホ/PWA でも本文を書け、IndexedDB に安全に保存・復元でき、GitHub 経由で最低限の手動 Push/Pull ができ、複数環境で同じテストデータを扱える |
| **MVP Beta** | ローカル活用基盤 | Alpha で蓄積した本文を、外部 API なしで活用する（辞書生成・ローカル校正・フロータイム最小・アプリ内通知） |
| **MVP Gamma** | 介入型支援・外部校正 | ユーザーに明示的に介入する支援機能を安全に入れる（ポモドーロ正式・ブラウザ通知/音・外部 API 校正） |
| **MVP Delta 以降** | 外部連携・高度支援 | Web Push・Discord・Notion・LLM 校正・矛盾検知・設計カード照合・PR レビューコメント連携 |

---

## MVP Alpha: ローカルファースト執筆基盤

### 目的

- スマホ/PWA でも本文を書ける
- IndexedDB に安全に保存・復元できる
- GitHub リポジトリ経由で最低限の手動 Push/Pull ができる
- 複数環境で同じテストデータを扱える

### 含める

- Vite + Tiptap v3 の本文編集
- 作品・チャプター管理の最小 UI
- IndexedDB 保存・復元
- GitHub 主導の最低限の同期
- Cloudflare Worker 等を使う場合は、GitHub 連携・認証・API プロキシ・トークン境界の最小範囲（→ [GitHub 同期・Cloudflare Worker 最小責務](#github-同期cloudflare-worker-最小責務237240)）
- PWA/スマホ/IME の執筆成立範囲（→ [PWA・モバイル・IME 保証範囲](#pwaモバイルime-保証範囲239)）
- 差分確認
- 保存/同期ステータス表示（→ [通知レベル Level 0](#通知レベル241)）
- GitHub 未接続時にも本文を書き始められる退避モード
- TXT / Markdown / JSON の退避出力
- エディタ内検索（`FindReplaceMod.jsx`）
- スタイルルールチェックとチェック結果表示（Lint 系 → [検索・本文チェック機能](FUTURE_MAP.md#検索本文チェック機能--mvp-alpha--mvp対象外校正系)、用語定義 → [writing-check-policy.md](design/writing-check-policy.md)）

### 含めない

- 辞書生成
- ローカル校正
- 外部 API 校正
- LLM 校正
- 誤字脱字衍字・誤変換検出（スタイルルールチェックとは別。用語定義は [writing-check-policy.md](design/writing-check-policy.md) 参照）
- フロータイム実装
- ポモドーロ正式対応
- ブラウザ通知・通知音
- Web Push
- Discord / Notion / SNS 連携
- 高度なグラフ分析

### Alpha 完了の目安（通し導線）

短編 1 本を「書き始め → 保存 → 必要に応じて GitHub 同期または退避出力」できること。GitHub 未接続でも退避モードとして成立すること。E2E 保証は [#221](https://github.com/clockcrockwork/novel-ide/issues/221)、操作手順は [docs/MVP_GETTING_STARTED.md](MVP_GETTING_STARTED.md) を参照。

### 関連子 Issue

- [#216](https://github.com/clockcrockwork/novel-ide/issues/216) TXT / Markdown / JSON 退避出力
- [#218](https://github.com/clockcrockwork/novel-ide/issues/218) GitHub 未接続時の退避モード保証
- [#219](https://github.com/clockcrockwork/novel-ide/issues/219) データ復旧・バックアップ導線
- [#221](https://github.com/clockcrockwork/novel-ide/issues/221) MVP 通し E2E テスト
- [#222](https://github.com/clockcrockwork/novel-ide/issues/222) MVP 開始用 README / 操作メモ（→ [docs/MVP_GETTING_STARTED.md](MVP_GETTING_STARTED.md)）

> 前身の [#212](https://github.com/clockcrockwork/novel-ide/issues/212)（Local-only 寄りの旧定義）は本ドキュメント/#237 へ移行済みでクローズ済み。

---

## MVP Beta: ローカル活用基盤

### 目的

- Alpha で蓄積した本文を、外部 API なしで活用する

### 含める

- 作品から辞書生成
- 辞書管理
- 辞書 Git 同期
- ローカル校正
- ローカル校正結果表示
- フロータイム最小（→ [フロータイム・ポモドーロの段階](#フロータイムポモドーロの段階243)）
- WritingSession 保存
- アプリ内通知基盤（→ [通知レベル Level 1](#通知レベル241)）

---

## MVP Gamma: 介入型支援・外部校正

### 目的

- ユーザーに明示的に介入する支援機能を安全に入れる

### 含める

- ポモドーロ正式対応
- ブラウザ通知（→ [通知レベル Level 2](#通知レベル241)）
- 通知音
- 外部 API 校正
- API キー管理
- 送信前確認
- 送信範囲制御
- API 結果正規化

---

## MVP Delta 以降: 外部連携・高度支援

### 含める

- Web Push（→ [通知レベル Level 3](#通知レベル241)）
- Discord 通知（→ [通知レベル Level 4](#通知レベル241)）
- Notion
- LLM 校正
- 矛盾検知
- 設計カード照合
- PR レビューコメント連携
- 進捗停滞通知
- 締切リマインド

---

# ドメイン別 段階定義

各ドメインの「どの機能がどの段階か」を集約する。個別の詳細設計は、本表が指す既存ドキュメント（`FUTURE_MAP.md` / `flow-time.md` / `proofread/` / `ENVIRONMENT.md`）を参照する。**段階の判断はこの表が正。**

## PWA・モバイル・IME 保証範囲（#239）

novel-ide はスマホ/PWA でのローカル執筆が重要な前提であるため、PWA・モバイル・IME は Alpha から完全には外さない。一方で PWA の全機能を入れると肥大化するため、最小範囲のみを Alpha に含める。

### Alpha に含める

- [ ] スマホブラウザで本文入力が破綻しない
- [ ] iOS Safari で本文入力・保存・復元ができる
- [ ] IME composition 中に writingRules や decoration が過剰干渉しない
- [ ] VisualViewport / 仮想キーボード表示時にエディタ・footer・ツールバーが致命的に崩れない
- [ ] IndexedDB 保存がスマホでも成立する
- [ ] オフラインでも開いて編集できる最小キャッシュ方針を決める
- [ ] manifest / Service Worker の最小対応範囲を決める

### Alpha に含めない（後続フェーズ）

- Web Push
- Background Sync の完全対応
- 高度なインストールプロンプト
- 複数端末へのバックグラウンド同期
- PWA アイコン/スプラッシュの完全整備
- 通知を前提にしたリマインダー

関連: [#53](https://github.com/clockcrockwork/novel-ide/issues/53)（モバイル・PWA・IME 対応の親 Issue。**親 Issue 全体が Alpha 対象ではない**。Alpha subset は上表のみ）

## GitHub 同期・Cloudflare Worker 最小責務（#237/#240）

MVP Alpha はローカルファーストである一方、複数環境で同じテストデータを扱うため GitHub 主導同期を初動保証範囲に含める。GitHub OAuth / API プロキシ / トークン境界を安全に扱うため、Cloudflare Worker 等のサーバー側境界が Alpha から必要になり得る。ただし Cloudflare の全機能を Alpha に含めるわけではない。

### Alpha に含める可能性がある範囲

- [ ] GitHub OAuth / 認証補助
- [ ] GitHub API プロキシ
- [ ] GitHub token をフロントへ直置きしないための境界
- [ ] CORS / CSRF / rate limit 等の最小防御
- [ ] GitHub 同期用の最小 API

### Alpha に含めない範囲

- Cloudflare KV による校正結果同期
- Cloudflare KV/D1/R2 を本文保存先にすること
- Web Push 配信
- 外部 API 校正用の Worker プロキシ
- Discord / Notion / SNS 連携 Worker
- 高度なクロスデバイス同期サーバー

### 本文・token・API キーの保存場所（不変条件）

| データ | 主保存先 | 保存してはいけない場所 |
|--------|----------|------------------------|
| 本文 | IndexedDB（一次） + GitHub リポジトリ | Cloudflare（KV/D1/R2 に永続保存しない） |
| GitHub token | Cloudflare Worker 側のセッション境界 | フロントエンドへ直置きしない |
| 外部 API キー | （Gamma 以降）Worker KV | ブラウザに実キーを置かない（登録済みフラグのみ） |

詳細・環境変数は [docs/ENVIRONMENT.md](ENVIRONMENT.md)、現状の同期実装は [docs/FUTURE_MAP.md](FUTURE_MAP.md)「クロスデバイス同期（#101）」「GitHub 連携強化（#102）」を参照。
関連: [#101](https://github.com/clockcrockwork/novel-ide/issues/101) / [#102](https://github.com/clockcrockwork/novel-ide/issues/102)

## 通知レベル（#241）

通知は「保存/同期状態表示・アプリ内トースト・ブラウザ通知・通知音・Web Push・Discord 通知」が混在しやすい。レベルで段階分離する。
**ポモドーロ**は通知なしでは単なるカウントダウンになりやすく、正式対応には通知 UX が不可欠なため Level 2（Gamma）扱い。**フロータイム**は計測・蓄積が本質で通知は最小でよい（Level 1）。

| Level | 内容 | 段階 | 例 |
|-------|------|------|----|
| **Level 0** | ステータス表示（通知機能ではなくデータ保護の常時表示） | **Alpha** | 保存中 / 保存済み / 保存失敗 / 同期待ち / 同期中 / 同期失敗 |
| **Level 1** | アプリ内通知 | **Beta** | セッション開始/終了 / 長時間無操作確認 / 辞書生成完了 / ローカル校正完了 / 保存・同期失敗 |
| **Level 2** | ブラウザ通知・通知音 | **Gamma** | ポモドーロ作業終了 / 休憩終了 / 外部 API 校正完了 / アプリ非アクティブ時の完了通知 |
| **Level 3** | Web Push | **Delta 以降** | 締切リマインド / 目標文字数 / 進捗停滞 / アプリを閉じている状態での通知 |
| **Level 4** | Discord 通知 | **外部連携フェーズ** | 進捗報告 / 共同執筆通知 / サーバー内リマインド |

> 既存のポモドーロ通知実装（`src/lib/notify.js`、PR #40 でマージ済みの Web Notification）は **Level 2 相当の先行実装**として存在するが、MVP Alpha ではポモドーロ正式対応・ブラウザ通知を保証範囲に含めない。Alpha では Level 0 のステータス表示に留める。

関連: [#96](https://github.com/clockcrockwork/novel-ide/issues/96)（通知拡張）

## 校正・辞書・外部 API 校正の段階（#242）

校正を段階分離しないと、Alpha へ外部 API・Worker プロキシ・API キー管理・本文外部送信が混入する。Alpha では校正を扱わず、Beta で「Alpha で書いた本文から辞書生成 → 辞書を Git 同期 → ローカル校正へ使う」流れを検証する。

| 段階 | 含める |
|------|--------|
| **Alpha** | 校正なし / 辞書生成なし / 外部 API なし / スタイルルールチェック（Lint 系）は対象 |
| **Beta** | 作品から辞書生成 / ユーザー辞書管理 / 辞書 Git 同期 / typoCandidates 管理 / ローカル校正 / ローカル校正結果表示 |
| **Gamma** | 外部 API 校正 / API キー管理 / 送信前確認 / 送信範囲制御 / API 結果正規化 / ローカル辞書との除外・優先順位処理 |
| **Delta 以降** | LLM 校正 / 文脈校正 / 設計カード照合 / 矛盾検知 / PR レビューコメント連携 |

「校正なし」は誤字脱字衍字・誤変換検出を行わないという意味であり、スタイルルールチェック（Lint 系：表記・記法・禁則・文体の警告）は Alpha の対象に含まれる。用語定義（スタイルルール vs 校正）は [docs/design/writing-check-policy.md](design/writing-check-policy.md) を参照。

校正の詳細設計（ソース別 API・ルールエンジン・永続化）は [docs/proofread/](proofread/) を参照。`proofread/` の Phase 番号は実装詳細の順序であり、本表の MVP 段階が優先する。
関連: [#95](https://github.com/clockcrockwork/novel-ide/issues/95)（校正・品質の親 Issue）、[#256](https://github.com/clockcrockwork/novel-ide/issues/256)（本文チェック方針明文化）、[#258](https://github.com/clockcrockwork/novel-ide/issues/258)（検索・本文チェック機能の再分類 → [FUTURE_MAP.md](FUTURE_MAP.md#検索本文チェック機能--mvp-alpha--mvp対象外校正系)）

## フロータイム・ポモドーロの段階（#243）

フロータイムの本質は「ユーザー体験を損なわずに計測し、蓄積し、将来の可視化に使えるデータ形式として保持する」こと。ポモドーロは介入型タイマーで通知 UX と密接なため、フロータイムより後の段階で正式整理する。

| 機能 | 段階 | 扱い |
|------|------|------|
| フロータイム | **Alpha では実装しない** | データ形式・ファイル ID 安定・ビュー種別管理など、将来実装を阻害しない設計配慮のみ |
| フロータイム最小 | **Beta** | 低干渉な計測・WritingSession 保存・文字数差分記録・将来可視化可能な形式。通知は無操作確認など最低限（Level 1） |
| ポモドーロ正式対応 | **Gamma** | 介入型タイマー + ブラウザ通知/通知音（Level 2） |

詳細仕様（FlowSession / WritingSession・状態遷移・同期方針）は [docs/flow-time.md](flow-time.md) を参照。

---

## 既存ドキュメントとの責務差分

| ドキュメント | 責務 | MVP 段階に対して |
|------------|------|------------------|
| **docs/MVP_PLAN.md（本書）** | MVP 段階定義の**正** | Alpha/Beta/Gamma/Delta の保証範囲・対象外を確定する |
| [docs/FUTURE_MAP.md](FUTURE_MAP.md)（旧 ROADMAP.md） | 将来構想・候補機能・実装済み基盤の一覧 | **実装順ではない**。各項目に段階タグを付すが、確定段階は本書が優先 |
| [docs/flow-time.md](flow-time.md) | フロータイムの詳細仕様 | Alpha 実装外・Beta 最小（本書の段階に従う） |
| [docs/proofread/](proofread/) | 校正の詳細設計（API・ルール・永続化） | Alpha 校正なし・Beta ローカル・Gamma 外部 API（本書の段階に従う） |
| [docs/design/writing-check-policy.md](design/writing-check-policy.md) | スタイルルール vs 校正の用語定義・本文チェック方針 | Alpha のスタイルルール対象範囲と校正の段階分離を補足 |
| [docs/ENVIRONMENT.md](ENVIRONMENT.md) | 環境変数・デプロイ・Worker 設定 | Worker 最小責務と本文/token/キーの保存方針（本書と整合） |
| [docs/MVP_GETTING_STARTED.md](MVP_GETTING_STARTED.md) | MVP Alpha 本線の操作メモ | 本書を参照する利用者向け導線 |
