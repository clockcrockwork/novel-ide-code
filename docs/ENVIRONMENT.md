# 環境変数・設定値リファレンス

このドキュメントはローカル開発・デプロイに必要な設定値をまとめる。
**機密情報（シークレット）は絶対にコミットしない。**

---

## 開発ツール要件

- **npm >= 11.10** が必要（`engines.npm` + `engine-strict=true` で強制。古い npm では `npm ci` / `npm install` が EBADENGINE で失敗する）。
  - 理由: `.npmrc` / `worker/.npmrc` の `min-release-age=7`（新規公開パッケージを7日間解決しないサプライチェーン防御）が npm 11.10+ の機能で、旧 npm では**黙って無視される**ため。
  - ローカルの更新方法: `npm install -g npm@11`。
  - CI（`.github/workflows/ci.yml`）はグローバル npm を実行時取得し、`NPM_PIN` に固定した exact version（更新手順は [SUPPLY_CHAIN.md](SUPPLY_CHAIN.md)「外部参照の pin（Action / container image / 実行時取得 CLI）」）で更新する。ローカルの `npm install -g npm@11` とは別系統の値。

---

## フロントエンド（Vite）

現時点でフロントエンドに必要なビルド時環境変数はない。
将来追加する場合は `VITE_` プレフィックスを付けること（`import.meta.env.VITE_*` でアクセス可）。

---

## Cloudflare Worker（`worker/`）

### MVP Alpha における Worker の最小責務

MVP Alpha はローカルファーストだが、複数環境で同じテストデータを扱うため GitHub 主導同期を含む。GitHub OAuth / token を安全に扱うため、Cloudflare Worker は次の**最小責務のみ**を担う（段階の正は [docs/MVP_PLAN.md](MVP_PLAN.md#github-同期cloudflare-worker-最小責務237240) / [#240](https://github.com/clockcrockwork/novel-ide/issues/240)）。

- GitHub OAuth / 認証補助、GitHub API プロキシ
- GitHub token をフロントへ直置きしないためのセッション境界
- CORS / CSRF / rate limit 等の最小防御、GitHub 同期用の最小 API

**保存場所の不変条件**：

- 本文の主保存先は **IndexedDB（一次）と GitHub リポジトリ**。**本文を Cloudflare（KV/D1/R2）に永続保存しない。**
- GitHub token は Worker 側のセッション境界に置き、フロントエンドへ直置きしない。
- 外部 API キーは MVP Gamma 以降の話。Worker KV に保存し、ブラウザには登録済みフラグのみ（下記「校正機能の API キー」参照）。

Alpha 対象外（後続フェーズ）：Cloudflare KV による校正結果同期 / KV・D1・R2 を本文保存先にすること / Web Push 配信 / 外部 API 校正用 Worker プロキシ / Discord・Notion・SNS 連携 Worker / 高度なクロスデバイス同期サーバー。

### 設定ファイル: `worker/wrangler.jsonc`

| 設定 | キー | 説明 | 機密 |
|------|------|------|------|
| GitHub OAuth Client ID | `GITHUB_CLIENT_ID` | GitHub OAuth App の Client ID（公開値） | No |
| 許可オリジン | `ALLOWED_ORIGIN` | CORS で許可するフロントエンドの URL | No |
| KV Namespace ID | `SESSIONS.id` | セッション管理用 KV の ID | No（プレースホルダー） |

### シークレット（`.dev.vars` または `wrangler secret`）

| キー | 説明 | 設定方法 |
|------|------|---------|
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App の Client Secret | 後述参照 |

### ローカル開発のセットアップ手順

1. **GitHub OAuth App の作成**
   - https://github.com/settings/developers → OAuth Apps → New OAuth App
   - Homepage URL: `http://localhost:5173`
   - Authorization callback URL: `http://localhost:5173/auth/github/callback`
   - 作成後、Client ID と Client Secret を控える

2. **`worker/wrangler.jsonc` の更新**
   ```
   GITHUB_CLIENT_ID: 取得した Client ID に置き換える
   ALLOWED_ORIGIN: ローカルは http://localhost:5173 のまま
   ```

3. **KV Namespace の作成**
   ```bash
   cd worker
   npx wrangler kv namespace create SESSIONS
   # 出力された id と preview_id を wrangler.jsonc に記入する
   ```

4. **シークレットの設定（ローカル）**
   `worker/.dev.vars` を作成する（`.gitignore` 済み）：
   ```
   GITHUB_CLIENT_SECRET=取得したClientSecret
   ```

5. **シークレットの設定（本番）**
   ```bash
   cd worker
   npx wrangler secret put GITHUB_CLIENT_SECRET
   ```

### 本番デプロイ時の差分設定

| 設定 | ローカル値 | 本番値 |
|------|-----------|--------|
| `ALLOWED_ORIGIN` | `http://localhost:5173` | `https://your-app.pages.dev`（またはカスタムドメイン） |
| `SESSIONS.id` | preview_id を使用 | 本番 KV の id を使用 |

### client / worker のデプロイ順序（CSRF 変更時の注意。N4/N5/S4）

client（フロントエンド bundle）と worker は別々に配備されるため、`/github/*` の CSRF
必須化（M1）のような変更ではデプロイ順序が重要になる。

**配備順序: client → worker**（この順で配備すること）

- client を先に配備した場合: 新 client は `workerFetchWithCSRF()` で `X-CSRF-Token`
  ヘッダーを付けて送るが、旧 worker はこのヘッダーを検証しない（無視するだけ）ため、
  旧 worker への変更系リクエストは従来どおり成功する。**安全**。
- worker を先に配備した場合: 旧 client（`workerFetch()` を使う古い bundle）は
  `X-CSRF-Token` を送らないため、新 worker の `validateCSRFToken` に 403
  `csrf token missing` で拒否される。commit/PR/merge 等の変更系操作が失敗する。

**完了判定**: 配信された client bundle が実際に `X-CSRF-Token` を送っていることを、
配信環境（本番 origin）へのリクエストで確認する。具体的には、ログイン済み状態で
変更系操作（例: ファイル commit）を実行し、ブラウザの Network タブ（または
`curl`/開発者ツールの再送機能）で実際に送信されたリクエストヘッダーに
`X-CSRF-Token` が含まれることを見る。ビルド成果物（`dist/assets/*.js`）に
`X-CSRF-Token` という文字列が含まれるかを `grep` するだけでも一次確認になる
（コード上の存在確認であり、実際に送信されることの確認ではない点に注意）。
CDN / エッジ配信を使う場合は**全エッジへの反映確認**も行う（1回の確認では特定
エッジのキャッシュ・地理的近接ノードしか見えないため、複数回のリクエスト、または
別ネットワーク・別リージョンからの確認、あるいは CDN purge 後の再確認で、配信網
全体が新 bundle に切り替わったことを確かめる）。

**順序を守っても残る残留状態**: 上記の順序（client → worker）を守っても、
**「旧 client の bundle を既に開いたままのブラウザタブ」×「デプロイ済みの新 worker」**
という組み合わせは配備順序と無関係に一時的に発生する（ユーザーがデプロイ前からページを
開いたままの場合）。この状態では旧 bundle が `X-CSRF-Token` を送らないため、変更系操作は
403 になる。回復方法は**ページの再読み込みのみ**（新 bundle を取得すれば解消する）。
旧 bundle 側は今回追加した CSRF 専用エラー文言（`src/lib/github.js` の
`parseError`）を持たないため、汎用の「アクセスが拒否されました。」表示になる
（専用文言が出せるのは新 bundle 配備後のタブのみ）。同様に、CDN / エッジのキャッシュや
DNS 切替の伝播が完了する前に**新規にページを開いた**場合も、既存タブと同じ理屈で
一時的に旧 bundle を取得することがある（回復方法も同じくページの再読み込みのみ）。

### client / worker のデプロイ順序（entity write 世代拘束時の注意。#609 A-2）

上記 CSRF の順序（client → worker）とは別に、**#609 A-2（entity write の世代拘束。
`docs/data-model/sync-contract.md`「entity write の世代拘束と reconcile」）以降は
Worker-first（worker を先に配備してから client を配備する）が必須**である。旧 Worker は
新 client が送る `_manifestSha`/`_reconcile` を未検証のまま `files/{id}.json` の content
へ永続化してしまうため（`PUT /sync/file/:id` の body 検証がフィールド allowlist を
持たない旧実装）。新 client 側は pull 時に `_` で始まるフィールドを一律除去して吸収する
（`src/lib/sync.js` の `parseRemoteFile`）ため実害は限定的だが、配備順序を守ることで
そもそもの汚染発生を避ける。

---

## デプロイ先（未決定）

フロントエンドのホスティング先は検討中。

| 候補 | 利点 | 懸念点 |
|------|------|--------|
| **Cloudflare Pages** | Worker と同一エコシステム。将来の D1（DB）・R2（ストレージ）連携がシームレス。リモート通知（将来予定）との相性が良い | 無料枠の上限を要確認 |
| **Netlify** | 無料枠が広く個人利用に向く。設定がシンプル | Cloudflare のエコシステムと分離する |

→ PWA 対応・リモート通知・将来の DB 利用を前提とすると **Cloudflare Pages が推奨**。
　 個人利用のみに留める間は Netlify の無料枠でも十分。

---

## 将来追加予定の設定

| 機能 | 設定値（予定） | 備考 |
|------|-------------|------|
| Discord 連携 | `DISCORD_WEBHOOK_URL` or `DISCORD_BOT_TOKEN` | 進捗通知・称号機能 |
| Notion 連携 | `NOTION_API_KEY` | エクスポート出力先 |
| リモートプッシュ通知 | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push 用 |

---

## 校正機能の API キー（サーバー設定不要）

校正機能で使用する外部 API のキーは、**Cloudflare Worker の環境変数には登録しない**。
各ユーザーが自分で取得し、アプリの設定画面から入力する。
キーは **Cloudflare Worker の KV**（`USER_SETTINGS` namespace）に保存され、ブラウザには「登録済み」フラグのみが保持される。
ブラウザに実際のキーは置かず、Worker プロキシ経由でのみ使用する（セキュリティ設計の詳細は [docs/proofread/SOURCES.md](proofread/SOURCES.md) 参照）。

| API | キーの種類 | 取得先 | 保存先（Worker KV） |
|-----|----------|--------|-------------------------------|
| Yahoo! 校正 API | Client ID（アプリケーション ID） | [Yahoo! Developer Network](https://developer.yahoo.co.jp/) | `apikey:{login}:yahoo` |
| Gemini API | API Key | [Google AI Studio](https://aistudio.google.com/) | `apikey:{login}:gemini` |

### Yahoo! 校正 API の特徴

- 完全無料（無償提供）
- 利用制限: 1分間300リクエスト / リクエストボディ 100kB 以内
- Worker プロキシ経由で呼び出す（CORS 対応済みだが、キー保護のため Worker 経由を推奨）

### Gemini API の特徴

- 無料枠: Gemini 2.5 Flash で 10 RPM / 250 RPD（2026年現在。変更される場合あり）
- Worker プロキシ経由での呼び出し必須（課金キーをブラウザに露出しない）
- 詳細: [Gemini API 料金ページ](https://ai.google.dev/gemini-api/docs/pricing)
