# GitHub 連携 — 権限・リポジトリ境界・誤 push 防止 設計

> issue #151 の設計。novel-ide の GitHub 連携における信頼境界・token 最小化・リポジトリ境界照合・
> 誤 push 防止 UX・pull データ検証の **方針** を定める。実装ギャップは末尾の分解表で後続 issue に割り当てる。
>
> 前提: 信頼境界の全体像は [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) を正とする。本ドキュメントは GitHub 連携固有の詳細。
> 依存 issue #145（信頼境界・注入防御）は完了済みで、検証基盤（`validateGitHubWritePath` 等）は実装済み。

---

## 0. 現状サマリ

| 領域 | 既存実装 | 場所 |
|------|----------|------|
| API プロキシ | エンドポイント allowlist + PUT 時 write path 検証 + 5MB body 制限 | [worker/src/github-proxy.ts](../../worker/src/github-proxy.ts) |
| worker 側検証 | `validateGitHubWritePath` / `validateWorkspaceRootPath` / `validateBranch` / `validateFileName` | [worker/src/validation.ts](../../worker/src/validation.ts) |
| client 側検証 | `validateGitHubWritePath` / unicode / filename / clipboard（#145 基盤） | `src/lib/security/*.js` |
| commit | `commitFile` 内で write path 検証 | [src/lib/github.js](../../src/lib/github.js) |
| token | OAuth scope=`repo`。token は Worker セッション(KV)＋httpOnly cookie、ブラウザは `ghUser` のみ | [worker/src/auth.ts](../../worker/src/auth.ts) |
| 同期 | 固定 `{login}/.novel-ide` repo に push/pull | [worker/src/sync.ts](../../worker/src/sync.ts) |

GitHub への書き込み経路は **2 系統**ある:
- **同期系**: `{login}/.novel-ide` という固定 repo（境界は実装で固定済み）。
- **直接 commit 系**: `github.js` 経由でユーザーが開いた任意 repo に commit/PR（本設計の主対象）。

---

## 1. 信頼境界の定義

GitHub 連携で「信頼してはいけない値」と、それぞれの検証箇所・関数。

| 値 | 信頼レベル | UI 検証（UX目的） | API 最終防衛線（worker） | 関数 |
|----|-----------|------------------|-------------------------|------|
| owner | UNTRUSTED | repo 選択 UI | 認可済み repo 許可リスト照合（§3）**（実装済み: #283）** | [worker/src/github-proxy.ts](../../worker/src/github-proxy.ts), [worker/src/auth.ts](../../worker/src/auth.ts) |
| repo | UNTRUSTED | repo 選択 UI | 同上 | 同上 |
| branch | UNTRUSTED | branch 選択 UI | 同期経路・直接 commit 経路（proxy の contents PUT body）とも `validateBranch()` で検証 **（実装済み: #287）** | [worker/src/validation.ts](../../worker/src/validation.ts), [worker/src/sync.ts](../../worker/src/sync.ts), [worker/src/github-proxy.ts](../../worker/src/github-proxy.ts) |
| path | UNTRUSTED | `validateGitHubWritePath()` | `validateGitHubWritePath()`（PUT時） | github-proxy.ts |
| file name | UNTRUSTED | `sanitizeFileName()` | `validateFileName()` | validation.ts |
| commit message | UNTRUSTED | `validateCommitMessage()` | （body は不透明転送） | src/lib/security |
| IDB 上の連携メタ (`file.github`) | UNTRUSTED（DevTools 改ざん想定） | — | 上記 owner/repo/branch/path 各検証で再評価 | — |
| URL query / DevTools 改変値 | UNTRUSTED | — | API 側で再検証（UI を信用しない） | — |
| GitHub 由来の本文/MD/issue/comment | EXTERNAL | §5 で検証 | — | §5 |

**原則**:
1. **worker（API側）を最終防衛線**とする。UI 側の検証は UX（早期フィードバック）目的に留め、UI を通過したことを API が前提にしない。
2. IDB 上の `file.github`（owner/repo/branch/path/sha）は DevTools で改ざん可能とみなし、API 実行直前に各値を再検証する。
3. エンドポイントは allowlist 方式（既存）。許可リストにない method/resource は 403。

---

## 2. token 権限の最小化方針

### 現状

- OAuth App の scope = `repo`（private 含む全リポジトリの read/write）。最大権限。
- token はクライアントに渡さず、Worker の KV セッション＋httpOnly cookie で管理（[auth.ts](../../worker/src/auth.ts)）。

### 不変条件（必守）

- token をクライアント JS・localStorage・IndexedDB に保存しない。
- token をログ・画面・エラーレスポンス・export に出力しない（worker のエラーは GitHub 内部メッセージを除去して返す。既存 `security.test.ts` 参照）。
- token 失効時はセッションを破棄し、再ログインを促す。**（実装済み: GitHub API が 401 を返したら proxy・sync 両経路の `revokeSessionIfTokenInvalid` が `SESSIONS.delete` でセッションを破棄する。403 は権限不足・レート制限等で非失効の理由が多く対象外。#288）**
- 連携解除時に KV セッションと cookie を削除し、ブラウザ側 `ghUser` もクリアする。

### 段階的最小化

- **短期（本 issue 範囲外・方針のみ）**: OAuth App の制約上 scope を repo 単位に絞れないため、§3 の repo 許可リストで「token がアクセス可能な repo」と「アプリが書き込みを許す repo」を分離する。
- **中長期（フォローアップ issue 候補）**: **GitHub App + per-repo installation** への移行を検討。これにより GitHub 側で installation 単位に repo を限定でき、scope=`repo` の広さを構造的に解消できる。移行は認証基盤の変更を伴うため独立 issue とする。

---

## 3. リポジトリ境界の検証方針（採用: 認可済み repo 許可リスト）

### 「接続認可済み repo」の定義

ユーザーが GitHubModal で **明示的に選択して開いた / 連携した** repo の集合を「認可済み repo」とする。
固定同期 repo `{login}/.novel-ide` は常に許可リストに含む。

### 記録場所（実装済み: #283）

- worker セッション（KV）の `authorizedRepos: string[]`（lowercase `owner/repo`）が最終防衛線
  （[worker/src/auth.ts](../../worker/src/auth.ts) `/auth/authorize-repo`、`validateOwnerRepo` で入力検証）。
- クライアント側は [src/lib/github.js](../../src/lib/github.js) の `authorizedRepos` メモ（Set）を UX 用ミラーとして持つが、
  **API 側の許可リストを唯一の正**とする（クライアントミラーは信用しない）。ログアウト・セッション失効時は
  `clearAuthorizedRepos()` で新インスタンスへ差し替え、インフライトリクエストによる新セッション汚染を防ぐ。

### 照合タイミング（実装済み: #283）

push / pull / fetch / commit / PR 操作の **API 実行前** に worker（[github-proxy.ts](../../worker/src/github-proxy.ts)）で
owner/repo（lowercase 比較）を許可リストと照合し、範囲外は **403**（fail-closed）。固定同期 repo `{login}/.novel-ide` は常に許可。

### path / ファイルの境界（既存基盤を再利用）

- path traversal 拒否・`.git`/`.github`/`.env`/`.envrc`/`.env.*`/lock ファイル除外: `validateGitHubWritePath()`（client + worker ミラー）。
- branch 検証（`..`, `@{`, 制御文字等）: `validateBranch()`。
- 想定外拡張子: 既定では拒否せず警告に留める（小説 repo は `.md`/`.json`/`.txt` 中心だが、ユーザー資産の自由度を優先）。export/AI 送信側（#148/#150）で別途扱う。
- 大サイズ / バイナリ: PUT は body 5MB 上限（既存）。pull 側のサイズ・バイナリ判定は §5。

> 実装済み（#283）: worker への許可リスト照合・`/auth/authorize-repo`・クライアントの冪等な再認可（`authorizeRepo`）。

---

## 4. 誤 push 防止 UX の設計

`window.confirm` / `window.prompt` / `window.alert` は使用禁止（CLAUDE.md / lint）。すべて**モーダル**で実装する。

push 確認モーダルに表示する項目:

1. 対象 **repo / branch / path / file name**（API に渡る実値をそのまま表示）。
2. **差分プレビュー**（保存済み or remote との diff。既存 DiffMode / diffCore を再利用）。
3. **初回 push**（その repo へ初めて書き込む）時は強めの確認（チェックボックス確認など）。
4. **破壊的操作**（削除 / 大量変更 / 大幅な行削除）時は追加確認。
5. **main / default branch** への push 時は警告表示。
6. **remote が更新されている**場合は merge/diff 確認を必須化（盲目的上書きを禁止）。
7. push 後は **commit URL** を表示し、結果を追跡可能にする。

> 現状の同期は 3 秒 debounce の自動 push（`.novel-ide` 固定 repo）。本節は **直接 commit 系**（ユーザー repo への明示 push）を対象とし、自動同期とは別 UX とする。
>
> **実装済み**（[src/components/modals/PrePushModal.jsx](../../src/components/modals/PrePushModal.jsx)）:
> 1（repo/branch/path/コミットメッセージ表示）・2（diff プレビュー、最大 50 行表示）・3（初回 push のチェックボックス確認）・
> 5（デフォルトブランチへの push 警告）・6（remote 更新検出時のチェックボックス確認 + 盲目的上書き防止の sha 引き渡し）・
> 7（push 後の commit URL 表示）。4（破壊的操作の追加確認）は削除行数による警告表示まで（追加確認 UI は今後の拡張余地）。

---

## 5. pull / remote data を信頼しない方針

GitHub から取得する本文・Markdown・ファイル名・issue/comment は EXTERNAL。
**preview / export / AI 送信の前段**で検証する。

| 検査 | 方針 | 再利用関数 |
|------|------|-----------|
| 危険 HTML | Markdown は文字レベルエスケープ済み（`markdown.js`）。raw HTML を直接 DOM 挿入しない | `markdown.js` |
| Markdown injection | レンダリングは既存パーサ経由のみ | `markdown.js` |
| 不可視文字 / Bidi 制御文字 | 検出して可視化・警告（#147 と整合） | `detectInvisibleChars()` / `hasDangerousChars()` / `unicodeSafety.js` |
| ファイル名 | サニタイズ | `sanitizeFileName()` |
| path traversal 風の名前 | セグメント単位検証 | `validateGitHubWritePath()` |
| 巨大ファイル | サイズ閾値で警告/拒否（pull 側にも上限を設ける） | `validatePulledContent()`（実装済み: #285。5M 超 deny / 1M 超 warn） |
| バイナリ | テキスト前提。バイナリ検出時はエディタで開かず隔離 | `detectBinary()` / `isQuarantined()`（実装済み: #285 / #291。deny は active リスト外へ隔離） |

配線状況（`validatePulledContent()` を通す経路）:
- ✅ **open / pull 経路**: `GithubModal.jsx:handleOpenFile`（開く）、`sync.js:processPull` / `processConflict`（同期 pull・競合）、`AppContext.jsx:switchBranch`（ブランチ切替）。
- ⚠️ **未カバー**: push 前 diff プレビュー（`PrePushModal.jsx`）は `getFileContent()` の remote 本文を `validatePulledContent()` を通さず `computeDiffAsync()` に渡す。diff 行は React text 描画で XSS はないが、remote が後からバイナリ・巨大・Bidi/不可視文字入りへ変化した場合の検証は未適用。follow-up（§8）。

責務分担:
- **#148**: export 時の危険 HTML・外部参照・情報漏洩。
- **#150**: AI / 校正 API へ送る本文範囲・秘匿情報制御。
- 本 issue は「pull 直後〜preview の前段」の検証方針までを定義する。

---

## 6. テスト方針

| 種別 | ファイル | 対象 |
|------|----------|------|
| 単体（worker） | [worker/src/__tests__/validation.test.ts](../../worker/src/__tests__/validation.test.ts) | `validateGitHubWritePath` / `validateBranch` / `validateWorkspaceRootPath` の境界違反 |
| 統合（proxy） | [worker/src/__tests__/github-proxy.test.ts](../../worker/src/__tests__/github-proxy.test.ts)（既存） | 許可外 endpoint 403・`.github`/`.env`/lock 403・path traversal 403・空セグメント 400 |
| E2E（将来） | `e2e/security/github-connection-boundary.spec.js` | 認可外 repo へ push 拒否・DevTools 改変で API 拒否・push 前 repo/branch/path 表示・remote 差分警告・token 非露出 |

本 issue で追加するのは worker validation の単体テスト（§B）まで。repo 許可リスト照合と UI 境界の E2E は実装 issue で追加する。

---

## 7. 受け入れ条件との対応

| 受け入れ条件 | 対応 |
|-------------|------|
| owner/repo/branch/path の検証方針がある | §1, §3 |
| token 権限を最小化する方針がある | §2 |
| UI だけでなく API/worker 側で認可済み接続情報と照合 | §1 原則1, §3 |
| path traversal / 危険ファイル名を拒否できる | §3（既存 `validateGitHubWritePath`） |
| push 前に repo/branch/path/差分を確認できる | §4 |
| pull データも信頼せず validation | §5 |
| token がログ・画面・エラー・export に漏れない | §2 不変条件（既存 `security.test.ts`） |
| 単体 or E2E で境界違反を検証 | §6（worker validation 単体テスト追加） |

---

## 8. 実装ギャップ → フォローアップ issue 分解

| ギャップ | 内容 | 規模 |
|---------|------|------|
| repo 許可リスト照合 | worker セッションに `authorizedRepos` を持ち、proxy で owner/repo を照合（範囲外 403）✅ #283 | 中 |
| 誤 push 防止モーダル UI | §4 のモーダル（repo/branch/path/diff/初回/main/remote 差分/commit URL）✅ PrePushModal.jsx（§4 項目 4 の追加確認 UI のみ拡張余地） | 大 |
| pull validation 統合 | §5 の検査を open/pull 経路（GithubModal open / sync pull・conflict / switchBranch）へ配線・巨大/バイナリ判定追加 ✅ #285 / #291。**残: PrePushModal の push 前 diff プレビュー remote fetch は `validatePulledContent` 未通過**（export/AI 前段は #148 / #150 の責務） | 中 |
| `.git` 明示拒否 | `validateGitHubWritePath` の禁止セグメントに `.git` を追加（client + worker ミラー両方）✅ #286 | 小 |
| proxy の branch 検証 | github-proxy の直接 commit 経路（PUT body の `branch`）を proxy 側でも `validateBranch` で検証 ✅ #287 | 小 |
| token 失効時のセッション破棄 | 401 受信時に `SESSIONS.delete` でKVセッションを削除し再ログイン導線を確立する（403は権限不足等で非失効のため対象外）。proxy・sync 両経路を `revokeSessionIfTokenInvalid` で共通化（実装済み: #288） | 小 |
| GitHub App 移行検討 | OAuth App → GitHub App + per-repo installation で scope 構造的縮小 | 大（要設計 issue） |
| WorkSettings（githubRepoPath）同期 | per-work の githubRepoPath を worker 同期する経路の実装。検証形状（per-work ネスト）・空値の扱い（フィールド単位 drop）は §9 で設計済み（#474）。実配線＋ネスト形状検証＋統合テストが未実装 | 中（設計は §9 で確定） |

---

## 9. WorkSettings（githubRepoPath）同期の検証設計（#474）

> **位置づけ**: 本節は**将来実装のための設計判断の記録**である。現状 `PUT /sync/settings` を叩く client コードは存在せず（未配線）、`serializeWorkSettingsForGit()` も未使用で、WorkSettings を worker 同期する機能は**まだ無い**。#469 の pre-commit-review で「トップレベル `githubRepoPath` guard の形状と将来の実配線が未定」と判明し、その2つの設計事項（検証形状／空値の扱い）を**実装着手前に確定**しておくのが本節の目的。実装者はこの設計に従って配線し、逸脱する場合は本節を更新すること。

### 9.0 データモデルの前提

- `githubRepoPath` は **per-`WorkSettings`** のフィールド（`fileMetadataStore.js` の `workSettingsMap: { [workId]: { id, label, githubRepoPath? } }`）。作品ごとに個別の rootPath を持ち、**単一のグローバル値ではない**。
- `serializeWorkSettingsForGit(work)`（`serializeMetadataForGit.js`）は per-work の `{ id, label, githubRepoPath? }` を返し、`githubRepoPath` が非文字列/無効/未設定なら**そのフィールドを omit**する（client 側は既にフィールド単位 drop）。
- `PUT /sync/settings` は `settings.json`（現状グローバル UI 設定のみ）を repo `.novel-ide` に書く。#469 で配線したトップレベル `Object.hasOwn(settings, 'githubRepoPath')` guard は**防御多層に過ぎず、per-work のデータモデルとは形状が一致しない**（TRUST-BOUNDARY.md「client↔worker 検証ペア」限界注記）。

### 9.1 決定: 検証する形状 — per-work のネスト（トップレベル単一値は不採用）

- **トップレベル単一 `settings.githubRepoPath` は不採用**。per-work の複数値を1つのグローバル値で表現できず、データモデルに反する。
- **WorkSettings は per-work コレクションとして同期する**。形状は次のいずれか（実装時に確定）:
  - (a) `settings.json` 内にネスト配列 `settings.workSettings = [serializeWorkSettingsForGit(w), ...]`（既存 `PUT /sync/settings` が body を parse するため、そのハンドラ内で反復検証を配線できる）
  - (b) **専用エンドポイント**（例 `PUT /sync/work-settings`。body を parse して反復検証）
  - **推奨は (b)**（settings.json をグローバル UI 設定に保ち関心を分離）。ただし (a) も可。
  - 🔴 (b) で work `id` を**書込先 path の一部**に使う実装（例 `writeRepoFile(..., \`work-settings/${id}.json\`, ...)`）を採る場合、`id` は untrusted なので **path traversal 検証を必須**とする（`validateFileName` 相当 / `FILE_ID_RE`。worker には現状 `validateWorkId` が無いので `../manifest` 等を弾く検証を追加）。§9 の反復検証は `githubRepoPath` のみを保証し、`id` を path に使う場合の検証は別途要る。
- 🔴 **transport は「worker が content を parse する経路」に限る**。既存の汎用 file-sync 経路（`PUT /sync/file/:id` → `files/{id}.json` を **opaque に書く**）は content-aware 検証をしないため、これで WorkSettings を運ぶと反復検証がバイパスされ **fail-open** になる。「専用ファイルを file-sync で運ぶ」案は**採らない**（parse する専用エンドポイント (b) か、parse される settings.json ネスト (a) のみ）。
- 🔴 **反復前に入力コンテナ/要素の形状ゲートを通す**（untrusted parse 直後）。コレクションが**配列でない**（例 raw PUT で `workSettings: "../../.git"`〔文字列〕）と `for...of` がコードポイント反復して誤動作、要素が**非オブジェクト/null**（例 `[null, 42, {...}]`）だと `w.githubRepoPath` 参照で throw→500、あるいは object 形状だと反復自体がスキップされ検証を通らず**元 body がそのまま書かれる fail-open**。反復前に `Array.isArray(workSettings)`、各要素に `typeof w === 'object' && w !== null` を要求し、外れた入力は 400 か（可用性優先なら）その要素を drop する。
- **worker は parse したコレクションの各要素の `githubRepoPath` を反復検証する**（`validateWorkspaceRootPath`。§9.4 の path 型フィールド集合に従う）。untrusted JSON の配列反復・オブジェクト構築ではプロトタイプ汚染対策（`Object.hasOwn` / `Object.create(null)`、INVARIANTS.md #11）を守る。

### 9.2 決定: 空値/クリアの扱い — フィールド単位 drop（全体 400 は不採用）

- `githubRepoPath` は**任意**。未設定（undefined/absent/空文字）＝「rootPath 無し＝repo ルート」であり、**正当な状態**（無効ではない）。
- **検証は非空文字列のときのみ行う**。absent/undefined/null/空文字は「未設定」として扱い、検証をスキップして repo ルート扱いにする。
- **非空だが無効な値（例 `../etc`）はフィールド単位 drop**。当該 `githubRepoPath` フィールドのみ落とし（その作品は rootPath 無し＝repo ルートで同期）、他フィールド・他作品は保存する。**リクエスト全体を 400 にしない**（#469 の pre-commit-review が指摘した可用性フットガン: 1フィールドの不正で theme/font 等無関係な同期まで巻き添えで失敗する）。
- **drop の永続化フロー（多段）**: worker は ①body を parse → ②各 work の `githubRepoPath` を検証 → ③無効なら当該フィールドを除いた **sanitized な work オブジェクトを `Object.create(null)` で再構築**（untrusted キーの再構築、INVARIANTS.md #11）→ ④**sanitized コレクションを元 body に代入し直してから** `writeRepoFile` で書く。🔴 形状(a) の場合、既存ハンドラは `writeRepoFile(c, login, 'settings.json', settings, ...)` のように **parse 済み body `settings` をそのまま書く**（`sync.ts:225`）。per-work をループ検証しただけで書込を既存のままにすると**元の無効配列がそのまま git に書かれる**ため、`settings.workSettings = sanitized` のように **sanitized 配列を body に再代入する**こと（step④ の「元 body に代入し直す」はこれを指す）。**git に書くのは必ず sanitized 版**（無効値を含む元 body をそのまま書かない）。
- **fail-closed は維持**: 無効な path は決して書かれない（drop）。drop 先は repo ルートで安全。「フィールドを落とす」＝fail-closed であり fail-open ではない。
- この方針は client `serializeWorkSettingsForGit`（無効を omit）・client `normalizeWorkSettings`（`normalizeFileMetadata.js` 内。無効 githubRepoPath をフィールド単位 drop）と**一致**し、client↔worker で「何が永続化されるか」の合意が保たれる。
- 🔴 **fail-closed の範囲は write 経路に限定**。GET `/sync/settings`（`sync.ts:188`）は settings.json を**無検証で verbatim 返却**する。攻撃者が GitHub 上で settings.json を直接編集、または別 id の `PUT /sync/file/:id`（opaque 書込。§9.1 で WorkSettings transport には禁止したが、任意 JSON を書ける経路自体は残存）や共同編集者経由で無効 `workSettings[].githubRepoPath` を repo に置くと、pull 時に無検証で client へ返る。現状 pull 側の唯一の防波堤は client `normalizeWorkSettings`（`normalizeFileMetadata.js`。§5「pull/remote data を信頼しない」方針）である。**防御多層として、pull/GET 側でも per-work `githubRepoPath` を再検証する**ことを推奨（write 側検証だけを唯一の層にしない。client normalize の回帰や raw を読む別コンポーネント追加で穴が開く）。

> **トップレベル guard との関係（分離・必須残置）**: #469 で `PUT /sync/settings` に配線したトップレベル `Object.hasOwn(settings,'githubRepoPath')` guard は、per-work 検証とは**独立した防御多層**であり、per-work のデータモデルが決して生成しないトップレベル形状を「万一来たら弾く」ためのもの。本 §9 の per-work 検証を配線しても**この guard を触らない**。🔴 **必ず残置する（削除禁止）**: per-work 検証経路は `settings.workSettings` を見るため**トップレベル `settings.githubRepoPath` を検査しない**。raw に `PUT /sync/settings` を直接叩いて `{"githubRepoPath":"../../.git","theme":"x"}` を送る攻撃に対しては、このトップレベル guard が唯一の層である。「per-work 経路ができたから冗長」と誤認して清掃削除すると防御多層の最後の1層が消える。9.2 のフィールド drop 方針は per-work 検証経路にのみ適用し、トップレベル guard の 400 挙動には適用しない（両者は別経路・別責務）。

### 9.3 client/worker parity（#469 不変条件）の維持

- どの形状でも per-work `githubRepoPath` 検証は両側で **`validateWorkspaceRootPath`**（同名だが**別ファイル・別実装**）を使う。受理集合は parity テスト `rootPathValidationParity.test.js`（source/flags 一致）で機械保証されるが、🔴 **戻り値契約は真逆**なので worker 配線時に client の idiom をそのまま移植してはならない:
  - client `validateWorkspaceRootPath(p)`（`validateWorkspaceSettings.js`）→ **`{ ok, reason }`**。OK 判定は `.ok === true`。
  - worker `validateWorkspaceRootPath(p)`（`worker/src/validation.ts`）→ **`string`（エラー理由）| `null`（OK）**。OK 判定は `=== null`。
  - **worker の drop 判定は `if (validateWorkspaceRootPath(p) !== null) { /* この work の githubRepoPath を drop */ }`**。client 側の `serializeWorkSettingsForGit`/`normalizeWorkSettings` が使う `.ok` idiom（`serializeMetadataForGit.js` / `normalizeFileMetadata.js`）を worker にコピーすると、worker の戻り値は文字列/`null` で `.ok` が常に `undefined` になり、**無効 path が drop されず git に書かれる fail-open**になる（pre-commit-review 敵対的系統が `../../etc/passwd` の書込を実測再現）。
- フィールド drop 方針も client `serializeWorkSettingsForGit` と揃え、「client が送らない値／worker が落とす値」の集合を一致させる。実装時は WorkSettings 同期の統合テストで client 送出形状と worker 受理形状の一致を固定する。

### 9.4 検証対象の path 型フィールドを明示管理する

- 現状 WorkSettings の path 型フィールドは `githubRepoPath` のみ。将来 `githubExportPath` 等の path 型フィールドを WorkSettings に追加する際、§9.1 の反復検証に**自動では乗らない**（「パス型かどうか」を実装者が手動認識する必要がある）＝未検証の untrusted path が git write に到達する拡張リスク。
- 対策: WorkSettings の **path 型フィールド集合を明示的な allowlist / 定数**として持ち、反復検証はその集合を回す。新規 path 型フィールド追加時はこの集合への追加を必須にする。
- 🔴 **client↔worker の集合 parity テストを required とする**。worker allowlist（`worker/src`）と client のシリアライズ対象（`serializeWorkSettingsForGit`、`src/lib/metadata`）は**別コードベースで共有 import が無い**ため、§9.3 の関数 source 一致テストと同型で、**両側の path 型フィールド集合が一致すること**を機械検査する（`rootPathValidationParity.test.js` の `FORBIDDEN_PKG` 集合一致テストと同じパターン）。これが無いと、client serialize に新 path フィールド（例 `githubExportPath`）を足して worker allowlist への追加を忘れた場合に drift が検出されず、未検証の untrusted path が worker の git write に到達する。

### 9.5 実装完了時に更新する後方参照（stale 化防止）

WorkSettings 同期を実配線・テスト完了したら、「未配線／未使用」を主張している次の後方参照を**同一 PR で更新**すること（更新漏れは実態と食い違う限界注記を残し、後続の二重実装や誤った検証スキップを招く）:

- 本節冒頭の「位置づけ」（未配線・`serializeWorkSettingsForGit` 未使用の記述）
- §8 ギャップ表の「WorkSettings（githubRepoPath）同期」行（未実装 → 実装済み）
- `TRUST-BOUNDARY.md`「client↔worker 検証ペア」の限界注記（「流れる経路は無い／`serializeWorkSettingsForGit` も未使用」）
- `worker/src/sync.ts` の `PUT /sync/settings` コメント（本節ポインタ）

---

## 関連ドキュメント

- [TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) — 信頼境界の全体リファレンス（本書の親）
- [docs/data-model/INVARIANTS.md](../data-model/INVARIANTS.md) — メタデータ操作の不変条件
- [docs/data-model/sync-contract.md](../data-model/sync-contract.md) — 同期契約（データ分類・エラー意味論・init 安全性）。**同期された GitHub 座標は認可ではない**（§3 の境界は同期経由の座標にもそのまま適用する）
- [docs/ENVIRONMENT.md](../ENVIRONMENT.md) — Worker / OAuth / token 設定
- [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) — レビュー時セキュリティチェック
