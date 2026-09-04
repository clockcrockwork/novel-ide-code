# Client-side Threat Model

> novel-ide の **ブラウザクライアント側**脅威モデル。信頼境界・資産・攻撃者モデル・攻撃面・
> データフロー別のリスク・将来機能の脅威を整理する。
> 監査の具体 Findings は [client-and-github-security-audit.md](client-and-github-security-audit.md)、
> 信頼レベル定義は [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md)、ローカル保存は
> [LOCAL-STORAGE-PROTECTION.md](LOCAL-STORAGE-PROTECTION.md)、GitHub 境界は
> [github-boundary.md](github-boundary.md) を親/兄弟文書とする。
>
> このファイルは AIエージェント（Claude / Codex / Gemini）が新機能を実装する前に読むべき
> 「何を守るか・何を敵とみなすか・何を送ってよいか」の設計前提集である。

---

## 1. 資産（守るべきもの）

| 資産 | 説明 | 漏洩/改ざん時の影響 | 保存場所 |
|------|------|--------------------|----------|
| 小説本文 | ユーザーの創作物（未公開含む） | 私的作品の流出・先行公開 | IDB `files` / GitHub |
| 私的メモ / annotation / 設計カード | 非公開のメモ・ハイライト・設定 | 私的情報の流出 | IDB `annotations` / `fileMetadata` |
| `file.github`（repo/branch/path/sha） | 作品とリポジトリ構成の対応 | repo 構成・命名の推測 | IDB `files` |
| GitHub token | scope=repo の広い権限 | **全 repo の read/write 乗っ取り** | worker KV のみ |
| session cookie | 認証済みセッション | なりすまし | httpOnly cookie |
| CSRF token | 変更系リクエストの正当性 | CSRF 補助 | メモリ（`workerClient`） |
| entitlement（将来: Pro/課金） | 有料機能の可否 | 不正な機能解放・売上毀損 | （**サーバ側で判定すべき**） |
| AI API key（将来） | 外部 AI へのアクセス | 課金悪用・鍵流出 | （**worker のみ**） |

**最重要不変条件**: GitHub token / API key / session secret は **ブラウザの JS-readable 領域
（localStorage / sessionStorage / IndexedDB / 非 httpOnly cookie / JS 変数）に置かない**。
現状これは守られている（token は worker KV + httpOnly cookie のみ）。

---

## 2. 攻撃者モデル

| 攻撃者 | 能力 | 主な脅威 |
|--------|------|----------|
| **悪意ある Web ページ**（別オリジン） | ユーザーに別サイトを踏ませ、クロスサイトリクエストを試みる | CSRF（変更系 API 悪用）、クリックジャッキング |
| **中間者 / ネットワーク** | 通信傍受・改ざん（HTTPS 前提では困難） | token/本文の傍受（HTTPS + HSTS で緩和） |
| **共有端末の後続利用者** | 同一ブラウザプロファイルへの物理アクセス | IDB 残留本文の閲覧、ログイン状態の悪用 |
| **DevTools を使う本人**（自己改ざん） | 自分の IDB/LS を書き換える | 破損データ注入・entitlement 改ざん（自傷 + sync 経由の他デバイス伝播） |
| **悪意ある GitHub コンテンツ提供者**（EXTERNAL） | ユーザーが開く repo / PR / issue の内容を制御 | Bidi/不可視文字、XSS（preview 拡張時）、prompt injection、誤認による誤操作 |
| **悪意あるインポートデータ / クリップボード** | ユーザーが貼り付け/取り込むデータを制御 | 不可視文字・巨大 payload・object injection |
| **XSS を得た攻撃者**（将来 XSS が入った場合） | ページ内 JS 実行 | JS-readable 領域全滅（token は httpOnly で緩和、本文/IDB は全読み取り可） |

**設計原則**:
- ブラウザ内保存領域は信頼境界ではない（DevTools/XSS で読み書き可能）。→ 読み出し時に必ず正規化、secret を置かない。
- worker が最終防衛線。UI 検証は UX 目的。
- EXTERNAL（GitHub / import / clipboard）は untrusted。IDB に入っても untrusted のまま。

---

## 3. 信頼境界図（クライアント視点）

```
                    ┌─────────────────────────── Browser origin ───────────────────────────┐
   EXTERNAL         │                                                                       │
  ┌─────────┐       │   UNTRUSTED store            React state / editor        描画          │
  │ GitHub  │──pull─┼─► IDB files/folders ──norm──► filesStore ───► WriteMode(text) ──► DOM │
  │ API     │       │   （EXTERNAL/UNTRUSTED）      （files: 正規化済）  PreviewMode(escape) │
  └─────────┘       │        ▲  ▲                                                            │
  ┌─────────┐       │        │  └─ folders: 正規化あり(L1)                                    │
  │clipboard│──paste┼────────┘                                                              │
  │ import  │       │                                                                       │
  └─────────┘       │   localStorage(ide_*: 非secret)   sessionStorage(scroll)              │
                    │   memory: CSRF token                                                  │
                    └────────────────────────────────────────────────────────┬──────────────┘
                                        │ fetch(credentials:include)          │
                          ┌─────────────▼──────────────┐          httpOnly cookie(Lax/secure)
                          │  Cloudflare Worker (BFF)     │◄────────────────────┘
                          │  KV: session/csrf/state/rl   │
                          │  env: OAuth secret           │──Bearer token──► GitHub API
                          │  最終防衛線: 認可/CSRF/path    │
                          └──────────────────────────────┘
```

境界を越える時の検証:
- **GitHub → IDB（pull）**: `validatePulledContent()` + `sanitizeFileName()`（呼び出し側で実施、L2）。
- **IDB → state（hydrate）**: files は `normalizeFileRecords()`、folders は `normalizeFolderRecords()`（L1 対応済み、本 PR の MF2）。
- **state → DOM（描画）**: write は React text node、preview は `markdown.js` 文字エスケープ。
- **クライアント → worker（変更系）**: `/github/*`（prefix 一括）・`/sync/*`（per-route）・authorize は CSRF token 必須（M1 修正済み）。⚠️ `/auth/logout`・`/auth/refresh` は例外（F-4、`/auth/*` の見直しは保留）。
- **worker → GitHub（書込）**: `authorizedRepos` 照合 + `validateGitHubWritePath` + `validateBranch`。
- **不変条件（S4）**: logout / セッション失効時は CSRF token cache（`workerClient.js` の `cachedCSRFToken`）を破棄し、**in-flight の refresh も無効化する**（`clearCSRFToken()` の世代カウンタ `csrfGeneration` が担保。破棄前に開始した refresh の応答が後から到着しても書き戻さない）。将来この cache 管理を書き換える際、破棄だけして in-flight を放置すると、破棄直後に旧セッションの token が復活しうる。

---

## 4. データがどこへ行くか（送信面の整理）

### ブラウザに保存されるデータ
本文・ファイル/フォルダ名・`file.github`・metadata・annotations・設定・`ghUser`（非 secret）・deviceId。
→ **secret は保存されない**（token/CSRF/session はブラウザ JS-readable 領域外）。

### GitHub へ送られるデータ
- 直接 commit 系（`/github/*`）: 本文・path・commit message・PR title/body・branch。認可済み repo のみ。
- 同期系（`/sync/*`）: 本文・name・`file.github`・manifest・settings・devices（userAgent/platform）。固定 `.novel-ide` repo。

### Worker へ送られるデータ
上記すべて（worker は GitHub への転送 BFF）+ CSRF token（ヘッダ）+ session cookie（自動）。
worker はレスポンスから GitHub 内部エラーメッセージを除去して返す（token/private 情報の漏洩防止、`security.test.ts`）。

### 将来 AI API へ送られ得るデータ（要 allowlist 設計）
本文（校正対象）・関連ファイル（context pack）・style reference。
→ **送ってはいけない**: token/CSRF/session、`file.github.sha` 等の内部識別子、他作品の非公開本文、private メモ、entitlement。
→ 送信は worker 経由（API key をクライアントに置かない）。allowlist 必須（監査 R8）。

### public repo へ出てはいけないデータ
private 制御ファイル（`.novel-ide` 相当）・非公開 docs・secret・内部メモ・`file.github`。
→ public 化前チェック（public-release-checklist.md）+ gitleaks ゲート（監査 FR5）。

### export へ混入してはいけないデータ
private metadata・custom field（allowlist 外）・コメント（`/* */`・`%%...%%`）・`file.github`・内部 ID。
→ metadata は `serializeFileMetadataForGit()` allowlist、本文は `stripComments`（監査 FR6）。

### cache に残ると危険なデータ
本文・`/github/*`・`/sync/*`・`/auth/*` のレスポンス・secret。
→ 現状 SW/PWA なしのため cache 残留はゼロ。導入時は allowlist + version + purge（監査 FR7）。

---

## 5. 攻撃面別リスク（現状）

| 攻撃面 | 現状の防御 | 残余リスク / 将来悪化条件 |
|--------|-----------|--------------------------|
| Markdown → HTML preview | 全テキスト文字エスケープ、固定タグのみ生成、`dangerouslySetInnerHTML` はエスケープ後のみ | preview が URL/画像/生 HTML/SVG/data URL を許すと XSS（FR8）。`dangerouslySetInnerHTML` を lint 管理（R1） |
| ファイル名 / フォルダ名 | `sanitizeFileName`（NFC + Bidi/不可視/制御除去 + 長さ）、React text 描画 | prompt 由来名の検証漏れ（L6）。folder 正規化あり（L1 対応済み） |
| GitHub write path | `validateGitHubWritePath`（client + worker）: `..`/null/backslash/Bidi/禁止セグメント | URL encode 差分は worker が `decodeURIComponent` 後に検証（両側整合）。責務分離（rootPath vs write path）維持 |
| repo 認可 | worker `authorizedRepos` 照合（lowercase 比較、fail-closed）、logout で clear、session 単位 | 大文字小文字は両側 lowercase で一致。encode 差異は 403（fail-closed）。account switch は KV session 再生成で分離 |
| CSRF | `/github/*`（prefix 一括）・`/sync/*`（per-route）・authorize は token 検証（M1 修正済み）。全経路 SameSite=Lax + CORS(ALLOWED_ORIGIN) + method allowlist も併用。⚠️ `/auth/logout`・`/auth/refresh` は CSRF/セッション検証なし（F-4、既知の例外） | Cookie を None にしたり GET 副作用を足すと token 検証だけでは防げない攻撃面が生まれうる。**既存の副作用付き GET（F-7、本 PR 外・残余として記録）**: `GET /auth/csrf-token` は毎回 KV 書込を行うが `/auth/*` 全体にレート制限が無く、有効セッションを持つ呼び出し元が無制限に叩けば KV 書込コストが際限なく積み上がる。**KV read-after-write の eventual consistency（round5 敵対的レビュー F、残余）**: `/auth/csrf-token` 発行直後の書込は Cloudflare KV の eventual consistency により、直後の `validateCSRFToken` の KV read が別 colo に当たると miss（`csrf token invalid`）しうる。client（`workerFetchWithCSRF`）は 403 を受けて `clearCSRFToken()` → 再発行で1回だけリトライするが、再発行も同じ書込であり同種の遅延を持つため理論上は解消しない。緩和（短時間 grace period・同一 token での再試行等）は未実装の残余。**世代ガードによる偽陰性（round6 敵対的レビュー、残余）**: `workerClient.js` の世代ガード（`csrfGeneration`）により、真のセッション失効 401 が後続世代の存在で抑止される偽陰性がある（ログアウトが発火しない）。次の変更系リクエストで再度 401 を受けて回復する（旧: 偽陽性ログアウトとのトレードオフ） |
| token 露出 | KV + httpOnly cookie のみ。エラーから GitHub 内部メッセージ除去 | クライアント露出経路なし（監査で確認）。error/log への混入を継続監視 |
| IDB 改ざん | files / folders は hydrate 正規化（`normalizeFileRecords` / `normalizeFolderRecords`、L1 対応済み）、quarantine（deny 隔離）、`FILE_ID_RE` 検証 | annotations は `normalizeAnnotations` 済み。metadata 本体正規化は範囲差あり（未確認領域） |
| 巨大 payload / DoS | `FILE_CONTENT_MAX`(5M)、pull バイナリ判定はサンプル 64K、body limit（github 5M/sync 2M）、diff 5000edit/64ms | `sanitizeFileName` は 4×maxLen 事前トリム。preview の巨大 markdown は仮想化対象外（WriteMode 除く） |
| prototype 汚染 | `Object.create(null)` / `Object.hasOwn` 読み（normalizeFileRecord）、lint `no-plain-object-dict` | metadata 側の網羅は未確認。動的キー導入時に注意 |
| clipboard / paste | `sanitizeClipboard.js`（不可視文字集計）| 全経路のカバレッジは未確認（未確認領域） |
| external URL 描画 | `rel=noopener`、HTTPS 前提 | `validateUrl` 未経由（M2）。UGC URL 描画で悪化 |

---

## 6. 将来機能の脅威（実装前チェック）

各機能を実装する AI エージェントは、着手前に該当行と監査の Predicted risks / lint 候補を読むこと。

| 機能 | 主脅威 | 実装前に決めること | 禁止事項 |
|------|--------|--------------------|----------|
| AI 校正 / 補助 | 本文/secret の過剰送信、prompt injection | 送信 allowlist、secret 除外、EXTERNAL の区切り、出力→副作用は人間承認 | 全量送信、API key をクライアントに置く、AI 出力を無検証で push/送信 |
| 課金 / Pro / 広告非表示 | entitlement のクライアント改ざん | entitlement は worker で判定、機能データはサーバゲート | LS/IDB の pro flag で機能可否を決める |
| 外部ストレージ連携（Notion/Discord/D1/R2/Supabase） | credential 露出、境界拡大 | credential は worker のみ、CSRF/認可を各連携に適用 | secret をクライアントに保存、連携先を無認可でアクセス |
| PDF/HTML/MD export 拡張 | private/secret 混入、生 HTML XSS | export フィールド allowlist、コメント除去、サニタイズ | 生 HTML 無サニタイズ export、metadata を allowlist 迂回 |
| import / backup / restore | 破損/悪意データ注入、object injection | import 時に正規化必須、型/サイズ検証 | 取り込みデータを無検証で IDB/state へ |
| share URL | 本文/認可の意図せぬ露出 | 共有範囲の明示、失効、認可チェック | 認可なしで本文を URL 経由公開 |
| PWA / offline cache | 本文/secret の cache 残留 | cache allowlist + version + purge、本文/secret 非 cache | `/github` `/sync` `/auth` レスポンスの cache |
| plugin / extension / bookmarklet | 任意コード実行、CSP 破り | サンドボックス、権限モデル、CSP 維持 | 第三者コードに token/本文への無制限アクセス付与 |
| collaborative editing | 認可・本文露出・改ざん | 参加者認可、変更検証、サーバ権威 | クライアントを権威にする、無認可参加 |
| public/private repo 分離 | 非公開 docs/secret の public 混入 | public allowlist/denylist、CI gitleaks ゲート | private 制御ファイルを public build に含める |

---

## 7. 実装時に「やってはいけない」パターン（AIエージェント向け）

監査の禁止事項と統合した早見表。**以下は原則禁止**:

1. GitHub token / API key / session secret を **localStorage / sessionStorage / IndexedDB / JS 変数 / 非 httpOnly cookie** に置く。
2. 変更系 Worker API を **CSRF token なし**で追加する（`workerFetch` の変更系誤用）。`/sync/*` と同様に `workerFetchWithCSRF` + `validateCSRFToken` を使う。
3. **CSRF / path / repo 認可をフロント側だけ**で完結させる。worker 側の再検証を省略する。
4. **IDB / localStorage 由来の値を trusted 扱い**して正規化せず使う（特に新 store の hydrate）。
5. **GitHub API response を無条件 trusted 扱い**する（URL を `validateUrl` なしで href/src、本文を検証なしで preview）。
6. 未サニタイズ本文を **`dangerouslySetInnerHTML`** に渡す。preview で `javascript:`/`data:` を通す。
7. **entitlement（Pro/課金）をクライアント状態**で判定する。
8. AI / 外部 API に **本文全量 / secret / `file.github` / 他作品**を allowlist なしで送る。
9. export / public build に **private metadata / secret / 非公開 docs** を混入させる（allowlist 迂回）。
10. `window.confirm/prompt/alert` を新規追加する（モーダルへ）。prompt 由来名を `sanitizeFileName` に通さない。
11. secret / private repo 名 / 本文 / token を **ログ / エラー / toast / コメント / docs** に出力する。
12. Cookie を `SameSite=Lax`/`Strict` から緩める（`None` 等）変更を、CSRF 影響（M1）評価なしに行う。

---

## 8. 関連ドキュメント

- [client-and-github-security-audit.md](client-and-github-security-audit.md) — 本監査の Findings / lint 候補 / Follow-up（本書の実データ）
- [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) — 信頼レベル定義・入力源別バリデーション
- [github-boundary.md](github-boundary.md) — GitHub 連携の権限・repo 境界・誤 push 防止設計
- [LOCAL-STORAGE-PROTECTION.md](LOCAL-STORAGE-PROTECTION.md) — ローカル保存データ保護方針
- [public-release-checklist.md](public-release-checklist.md) — public 化前の secret 混入チェック
- [../data-model/INVARIANTS.md](../data-model/INVARIANTS.md) — メタデータ/永続化の不変条件
- [../REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) — レビュー時セキュリティチェック
