# 同期契約（sync contract）

`.novel-ide` を介した cross-device 同期の**用語・データ分類・エラー意味論**の正本。

## 文書の状態

| 節 | 状態 | 実装済みか | 完成させる issue |
|---|---|---|---|
| §1 用語 | **draft**（entity write の世代拘束・reconcile は #609 A-2、同期完了判定（canonical identity hash）は #610、folder / `files.parentId` の 3-way merge・formatVersion 契約は #394 C-1 で確定済みだが、`fileOrder`→表示順の配線・settings の client 配線が残るため節全体は draft のまま） | file entity の同期完了判定（#610）・folder / `files.parentId`（#394 C-1）は実装済み | #611（folder/settings 等の残りの canonical identity 対象化・配線。`fileOrder`→表示順配線は issue-candidates.md 参照） |
| §2 データ分類 | **draft** | folder / `files.parentId` は同期対象（#394 C-1）。残余（fileMetadata / folderMeta / workSettings / annotation 等）は未対象 | #611 |
| §3 GitHub 座標 ≠ 認可 | **確定** | 実装済み（既存の認可境界を維持） | — |
| §4 エラー意味論 | **確定** | 実装済み | — |
| §5 init の安全性 | **確定** | 実装済み | — |
| §6 実装の所在 | **確定** | — | — |

**draft の節は「これから満たす目標」であり、現時点の保証ではない。** 各 draft 節には「現時点
では未達」の注記がある。A-2 / B が完了したら、担当 issue の実装者が該当節の状態を **確定**
へ更新し、節内の「現時点では未達」注記を削除する（この表の更新が完了条件に含まれる）。

関連: [INVARIANTS.md](INVARIANTS.md) / [docs/security/github-boundary.md](../security/github-boundary.md) /
[docs/security/TRUST-BOUNDARY.md](../security/TRUST-BOUNDARY.md)

## 1. 用語

### 同期完了（sync complete）

同期完了とは、**この端末の canonical workspace state が remote manifest の成立済み snapshot に
完全に含まれ、その snapshot から作品を再構成できる状態**をいう。

`isDirty === false` は同期完了の定義**ではない**。`files.isDirty` は宛先の違う 2 つの状態
（作品リポジトリへの commit と cross-device 同期）を兼ねており、同期完了の判定には使えない。
判定は canonical identity（hash）へ一本化済み（#610。§2「A2 を canonical identity の hash
対象にしない理由」参照）。

### 転送単位と完了単位

| 単位 | 内容 |
|---|---|
| 転送単位 | **entity**（file / folder / metadata / work / dictionary / annotation） |
| 完了単位 | **workspace snapshot**（manifest を snapshot index / commit marker とする） |

entity を個別に write し、すべて成功したのち manifest を更新して snapshot が成立する。

- manifest が指していない新 entity は orphan になってよい。
- 途中で失敗して manifest が更新されなければ、旧 manifest が指す snapshot が成立状態として残る。

A-1 で実装したのは「**失敗を含む回は snapshot を完了扱いにしない**」ところまで（`src/lib/sync.js`
の `finishSync` / snapshot commit 判定）。通常同期では失敗を含む回に manifest を更新しない。
init だけは例外で、push に成功した entity だけを載せた manifest を書く（§5 参照。書かないと
「entity はあるが manifest が無い」状態が恒久停止を生むため）。いずれの場合も `lastSyncedAt` は
進めない。

**#609 A-2 で満たした**（次節「entity write の世代拘束と reconcile」が契約の本体）:

- entity の write は「書く側が読んだ manifest 世代」（`_manifestSha`）と、manifest entry が
  持つ blob sha（`_sha`）の両方に拘束される CAS になった。in-place 上書きではない。
- manifest 更新の並行制御（CAS: expected revision の比較と 1 回の再試行）を定義した。

**現時点では未達**:

- orphan entity の回収（GC）と、remote 側の entity 削除経路は**未定義かつ担当未割り当て**。
  現状 worker に `DELETE /sync/file` は無く、ローカルで削除したファイルは remote に残り続ける
  （#609 の非目的。別 issue）。

### entity kind と担当（#609 が入力として必要とする範囲）

| entity kind | 現行 transport | snapshot への取り込み |
|---|---|---|
| file（本文） | `PUT/GET /sync/file/:id` | #609 |
| settings（canonical allowlist 分） | `PUT/GET /sync/settings`（**client 未配線**） | #609（entity write の世代拘束・reconcile は A-2 で実装済みだが、settings の **client 配線自体**は本 PR の非目的。#609 の残スコープとして残る） |
| devices | `PUT/DELETE/GET /sync/devices` | 同期 identity ではない（運用情報） |
| folder | manifest 内蔵（独立 entity route を持たない。`PUT/GET /sync/manifest` の `folders` dict + `files[id].parentId`） | #394（**実装済み**。folder の削除伝搬も含む。file の削除伝搬は非目的） |
| workSettings | **無し** | #611 |
| fileMetadata / folderMeta / 各種定義 | **無し** | #611 |
| annotation | **無し** | #611（本文との atomicity が条件） |

#609 は manifest の `formatVersion` と snapshot 構造を定義する際、**file と settings だけを
対象とし、folder / metadata / annotation の領域は #394 / #611 で追加する**（追加時に
formatVersion を上げる）。**#394 C-1 で folder を追加し、formatVersion を 3 へ上げた**
（`FORMAT_CAPABILITY_VERSION`。詳細は次節）。metadata / annotation は引き続き #611。

### manifest の formatVersion 契約（#609 A-2）

manifest の `version` フィールドは以前から書かれていたが、**読む側が存在しなかった**
（client の `buildRemoteMap` は `_branch` / `_sha` / `files` しか取り出さず、worker の
`PUT /manifest` は書き込み内容を検証しなかった）。したがって「remote が新しい
formatVersion を宣言している」という事実を誰も検出できず、旧い client/worker が新しい
version が要求するフィールドを理解しないまま上書きしうる状態だった。A-2 はこの
「書くだけで読まれない」欠落を閉じる。

**formatVersion に関わる 3 定数**（信頼境界をまたぐため、依存フリーな
`worker/src/syncErrorCodes.ts` を正として定義し、client 側の `src/lib/syncErrors.js` が
写しを持つ。値の一致は `src/lib/syncErrorCodeParity.test.js` が機械検査する —
`SYNC_ERROR_CODES` の code/category 集合と同じ理由・同じ機構）:

- `LEGACY_DEFAULT_FORMAT_VERSION`（`2`）: `version` が欠落・非整数（文字列・小数等）の
  manifest は、version を書かなかった旧 client が書いたものとみなしこの値として扱う
  （client・worker とも同名の `parseFormatVersion` の fallback。worker init が書く
  bootstrap manifest の placeholder version にも使う。値が壊れている場合の扱いは下記
  「既知の制約」参照）。
- `KNOWN_SAFE_FORMAT_VERSION`（`2`）: この client/worker が capability 宣言の有無に
  関わらず無条件に読み書きしてよい安全域の上限。**worker 側のゲート専用**
  （`worker/src/sync.ts` の次の 4 箇所にのみ使う: `checkFormatCapability` の書き込み
  version ガード〔`written > X && written > capability`〕、同関数の早期 return
  〔`remoteVersion ≤ X` かつ `written ≤ X`〕、`checkRemoteFormatVersion` の
  `remoteVersion > X` 判定、`PUT /sync/manifest` ハンドラの v2 形状検査の閾値
  〔`parseFormatVersion(writtenVersion) <= X`〕）。2 から上げてはならない（上げると
  早期 return が v3 への無検査書き込みを通す）。
- `FORMAT_CAPABILITY_VERSION`（**`3`**。#394 C-1 で 2→3 に上げた）: この client/worker 世代が
  実際に読み書きできる現行 version。capability header の送信値（`src/lib/workerClient.js`）、
  client の読み側「remote を読めるか」中止ゲート（`src/lib/sync.js` の `buildRemoteMap` /
  `syncAll`。**`KNOWN_SAFE_FORMAT_VERSION` ではなくこの値を使う** — worker 側の無条件許可域は
  2 のまま変えないため、client の読み側だけ `KNOWN_SAFE` で判定すると client 自身が v3
  manifest を書いた直後の次回読み取りで恒久停止する）、client が書く manifest body の
  `version`（`src/lib/sync.js` の `pushManifest`）で使う。

3 定数は #394 C-0 時点ではいずれも値が同じ（2）だったが、C-1 で `FORMAT_CAPABILITY_VERSION`
だけを 3 に上げた（`LEGACY_DEFAULT_FORMAT_VERSION` / `KNOWN_SAFE_FORMAT_VERSION` は 2 のまま。
意味の分離自体は下記「既知の制約」参照）。

### v3 manifest の形状（folders dict + files[id].parentId。#394 C-1）

v3（`version: 3`）は v2 の形状に次の 2 点を追加する。**entity の path space は変えない**
（`files/{id}.json` を継続。issue #394 本文が当初要求した v3 entity のパス空間分離は
「worker の formatVersion ゲートで代替する」という設計判断に改訂した。理由は下記
「既知の制約」参照）。

- `folders`: dict（`{id: {id,name,parentId,sortOrder,createdAt}}`）。folder の存在の正は
  この dict のみ（file の `parentId` から folder を合成しない）。
- `files[id].parentId`: 各 file の manifest entry に追加するフィールド（entity 本体
  `files/{id}.json` には含めない。parentId は manifest 側だけが管轄する）。

**読み寛容・書き厳格**（契約3。#394 C-1 round3 item13 で訂正）: 「読み寛容」は**個別
entry**（`folders` dict の中の 1 レコードが不正な value・`FILE_ID_RE` 不適合な key）に
限る — `sync/structure.js` の `parseRemoteStructure` / `normalizeRemoteFolders` はこれを
「不明」（missing ≠ empty。契約2）として merge 対象外にし、local を保持する（削除しない）
とともに、書き戻す manifest には生のまま carryOver する（`malformedFolderRaw`。削除として
伝搬させない）。**容器自体**（`files` / `folders` フィールド）が非 dict または欠落している
場合は寛容の対象ではない: worker の `PUT /sync/manifest` は書き込む version が 3 以上のとき
**`files` と `folders` の両方が plain object**（配列・null・欠落は拒否）でなければ 400 を
返す（`worker/src/sync.ts`）ため、**v3 を宣言した manifest の `files`/`folders` が非 dict・
欠落なのは手編集等の破損でしか生じない**。この場合 client の読み側（`buildRemoteMap`）は
corrupt として fail-closed にし、その pass では manifest を一切書かない
（structure unknown で継続すると、次に書き戻す際 `folders:{}` を書いて「全 folder 削除」
として他端末へ増幅しうるため）。**v2（`version<3`）で `folders` キー自体が無いのは正規の
未移行状態**であり、これは unknown（missing ≠ empty）として local を保持し v3 へ移行する
（corrupt にしない）。

folder / file の parentId は **base（前回この client が採用した structure の写し。
`syncState` の合成キー `#structure`）を使った 3-way merge**で解決する
（`src/lib/sync/structure.js` の `mergeStructure`）。同一 folder の同一フィールドが
base から両方向に乖離していれば remote を優先し、作成/削除の乖離は削除が勝つ
（決定的解決。conflict UI は作らない）。base が unknown（初回 v3 化・syncState 消失・
バックアップ復元後）なら削除判定はせず union する。hydrate（files/folders の store
読み込み）が完了していない同期パスでは structure 全体を unknown として扱い、削除判定・
local 適用・base 更新・manifest への新しい folders 書き込みのいずれも行わない
（`src/lib/sync.js` の `syncAll` が `filesLoaded && foldersLoaded` で判定する。
remote に無いことを「local が空だから削除された」と誤判定して他端末の folder を消す
事故を防ぐ）。**local への適用（`src/lib/sync/applyStructure.js`）は merge が返した明示差分
（削除 folder id 集合・upsert する folder レコード・変更された file の parentId）だけを
id 単位の関数形 patch でライブ状態へ当てる。ライブ store と merge 結果の差分から削除や
上書き対象を再導出しない**（同期パス開始後にユーザーが行った操作は、この適用では触らず
次回 pass の local として拾う）。**さらに適用はレコード単位の楽観的検証を伴う（#394 C-1
round5 F1）: upsert / 削除は、ライブの現在値が merge の local 入力に使った snapshot と
一致する場合にのみ行う。同期パス中（merge 計算〜適用までの窓）にユーザーが folder を
rename・移動・削除した、または file を移動した場合、ライブは snapshot と不一致になるため
その pass ではそのレコードに触れず巻き戻し・上書きを避ける**（conflict モーダル表示中の
file 移動も同様に、解決時点の live レコードを読んで parentId を引き継ぐ。`AppContext.jsx`
の `resolveConflictRemote` / `resolveConflictBoth`）。

**structure の知識を持たない端末は unknown を確定させない**（#394 C-1 round5 F2）: remote
structure が unknown（v2・非整数 version・folders 非 dict 等）で、かつ local にも folder が
1 つも無い（新規インストール・IDB クリア後等）場合、その pass では structure を書かない
（remote の version をそのまま維持し、`folders` キーは remote に生の値があれば verbatim
carryOver、無ければ書かない。`files[id].parentId` も書かない）。「local が空だから union の
結果も空」を v3 の確定値として書き戻すと、他端末の既存 folders を「全削除」として伝搬させて
しまうため。local に folder が 1 つでもあれば通常どおり v3 として書く（E1: v2→v3 初回移行）。

**files.github.sha は push payload・manifest entry・隔離ファイルの carryOver のいずれからも
除外する**（契約9。derived な remote concurrency state で別端末では意味を持たない。
§2「`files.github` はフィールド単位で分かれる」参照）。pull（`processPull`）は remote の
canonical 4 フィールド（owner/repo/branch/path）だけを採用し、`sha` は local の値を保持する
（部分更新。契約8）。同様に `createdAt`（epoch ms 数値）は remote が「数値かつ 0 より大きい」
値を持つときだけ採用し、無効なら local を保持する（`Date.now()` へは倒さない）。

**v2 内の追加フィールド（`entry.hash`。#610）**: manifest entry の `hash`（canonical hash。
`src/lib/sync/identity.js` の `computeCanonicalHash`）は v2 の形状を変えない追加フィールドで、
version bump を伴わない。旧 client（`hash` を知らない client）がこの manifest を読んでも
`files`/`fileOrder` 等の既知フィールドは変わらず読めるため formatVersion 判定には影響しない。
旧 client が manifest を書き戻すと `hash` フィールドは（他の未知フィールド同様）落ちる
（`pushManifest` は自身が把握しているフィールドだけを書くため）。この場合 `entry.hash` が
欠落した legacy entry になるが、次回同期時に該当 entity を live GET して 1 回だけ
canonical hash を補完する経路がある（`src/lib/sync.js` の `resolveClassification`。
`entry.sha`（blob sha）を live GET せず create-only 経路に倒す既存の legacy 補完
（#609 round2 F1/F4）とは別の bookkeeping）。

**read/write compatibility matrix**（`PUT /sync/manifest` の判定。`checkFormatCapability`
in `worker/src/sync.ts`）:

| remote の現在の version | request の capability 宣言（`X-Novel-Ide-Format-Version`） | request body 自身の `version` | 判定 |
|---|---|---|---|
| ≤ 2（既知安全） | 任意（未宣言含む） | ≤ 2（既知安全） | **許可**。両方が既知安全域なら capability・body の version を問わない |
| ≤ 2（既知安全）、または manifest 未作成 | 任意 | 3 以上、かつ capability 未満 | **拒否**（426）。remote/manifest 有無に関わらず、書き込む version が capability を超えることは許さない（自己矛盾: 書いた client 自身が読めない manifest を作ってしまう） |
| manifest 未作成（初回）かつ request が `_sha` を送っていない | 任意 | capability 以下（≤ 2 を含む） | **許可**（create として扱う） |
| manifest 未作成に見える（GET 404）が request は非 null の `_sha` を送っている | — | — | **拒否**（502 / `sync_upstream_error`。下記「GET 404 の扱い」参照） |
| 3 以上 | 未宣言、または remote 未満 | — | **拒否**（426 / `sync_protocol_upgrade_required`） |
| 3 以上 | remote 以上 | remote 未満（＝ downgrade） | **拒否**（426。下記「downgrade 防止」参照） |
| 3 以上 | remote 以上、かつ body version 以上 | remote 以上、かつ capability 以下 | **許可** |

判定は **remote 側の現在の `version` を独立に読み直して**行う。write する側の `_sha` /
body の `version` 申告は、write する側自身の主張であり「remote が既に何を宣言しているか」の
証拠にならない（旧 client が `version` を書き換えずに write すればすり抜ける）。GitHub の
SHA CAS は「誰かが後から書き換えた」競合は検出するが、「SHA は一致しているが中身の
formatVersion を理解しないまま上書きする」事故は検出しないため、`checkFormatCapability` は
`PUT /sync/manifest` の直前に `manifest.json` を 1 回追加で GET する（ファイル数に比例しない
固定コスト）。

**GET 404 の扱い（fail-closed）**: `GET /sync/manifest` 自身のコメントが警戒している通り、
GitHub Contents API は repo 作成直後のレプリケーション遅延で「本当は存在する」ファイルにも
404 を返しうる。`checkFormatCapability` の GET が 404 でも、request が非 null の `_sha` を
送っている（＝ client は既存 manifest の更新のつもりでいる）場合は矛盾したシグナルであり、
「未作成だから許可」へ倒さない。この矛盾を検出したら `upstream` category（502。時間をおいて
再試行を促す）で write 自体を進めない。これを閉じないと、読み取り遅延の窓に割り込んだ write
が実在する v3 manifest を検査なしで上書きできる（敵対的レビュー由来）。

**downgrade 防止**: capability header は「この client が理解できる上限」の自己申告であり、
実際に書き込む内容の保証ではない。header だけを見て許可すると、header で高い capability を
申告しながら body には低い `version` を書く（例: header=3, body.version=2）ことで、v3 の
manifest を検査なしで v2 形状へ書き換えられる。`checkFormatCapability` は capability に加えて
**書き込む body 自身の `version`** も remote の現在の version 以上であることを要求する
（敵対的レビュー由来）。

**header 送信は formatVersion ゲートを通る 2 ルートに限定する**（#619 レビュー round 13
指摘、#394 C-0 で entity write に拡張）: `workerFetchWithCSRF` は capability header を既定では
送らず、呼び出し側が `{ formatCapability: true }` を明示的に渡した場合だけ付与する。渡すのは
`pushManifest`（`PUT /sync/manifest`）と `syncFile`（`PUT /sync/file/:id`）の 2 箇所で、worker
がこの header を検査するのもこの 2 ルート（`checkFormatCapability` / `checkRemoteFormatVersion`）
だけだからである。以前は全変更系リクエストに一律付与していたため、フロントエンドを Worker
より先に配備するクロスオリジン構成では、新ヘッダーを知らない旧 Worker の CORS
`Access-Control-Allow-Headers` が preflight を拒否し、manifest 同期だけでなく entity 同期・
端末削除・repo 認可まで通信エラーになっていた（現在は entity write へ意図的に送る。項目 9
参照）。header 自体はこの 2 ルートに限定できたが、**#609 A-2 以降は entity write
自体が `_manifestSha`/`_sha`/`_reconcile` という新しいフィールドを常時送るため、CORS
preflight（header）とは別に body の観点で Worker-first 配備が実質必須になった**: 旧 Worker
はこれらのフィールドを「未知の body プロパティ」として `files/{id}.json` にそのまま
永続化してしまう（`PUT /sync/file/:id` が受け取った body を最小限しか検証しないため）。
新 client が pull し直す際は `parseRemoteFile`（`src/lib/sync.js`）が `_` で始まる
フィールドを一律除去して吸収するため実害は無いが、旧 Worker と新 client が混在する期間は
entity write 自体が旧 Worker のバリデーションに弾かれない前提で運用しないよう、Worker を
先に配備してから client を配備する順序を守ること（`docs/ENVIRONMENT.md` 参照）。

**client 側の対応する中止**: `syncAll`（`src/lib/sync.js`）は `GET /sync/manifest` で読んだ
remote の `formatVersion` が `FORMAT_CAPABILITY_VERSION`（この client 世代が読める上限）を
超えていれば、push/pull/manifest write を含む**全同期処理を停止する**（読み取りも含めて何も行わない。§4 の error 意味論に
準拠し `lastSyncedAt` は進めない）。「読み取りだけ許す」degrade ではなく完全停止にしている
理由: 未知 formatVersion の entity を旧いパーサで読むこと自体、その client が理解しない
フィールド構造を前提に IDB へ書き込む・UI に表示する経路を通ることになり、pull を許すことが
必ずしも安全ではないため（保守的な fail-closed を優先する）。

さらに、entity の write は `syncAll` を経由しない独立した経路が複数ある（`AppContext.jsx`
の debounce autosave＝`syncFileSilent`、conflict 採用時の `syncFile` 直接呼び出し）。これらは
manifest を読まないため、`syncAll` の中止だけでは formatVersion 超過後も entity write を
止められない（敵対的レビューで実証: `syncFileSilent` 経由で v3 remote に v2 body の entity
push が通ることを確認済み）。そのため `syncFile`（`pushOneFile`・`syncFileSilent`・直接
呼び出しすべての単一 choke point）自体に、`syncAll` が検出した中止状態を反映するモジュール
内フラグ（`_protocolUpgradeRequired`）を持たせ、entity write もここで一律に止める。
既知の残存窓（`_protocolUpgradeRequired` は単一の bool であり、非同期処理の in-flight
状態を厳密に追跡しない）:

- ページ読み込み直後、一度も `syncAll` が formatVersion を確認していない間はこのフラグが
  立たないため、その窓の entity write は防げない（IDB 永続化までは本 PR の範囲としない）。

`syncAll` が「manifest 不在＝formatVersion 衝突なし」と判定して `runInitSync` を呼ぶ間の窓
（init 自身の entity push を通しつつ、その await 中に debounce autosave 等の外部呼び出しも
通過してしまう懸念。Codex レビュー指摘）は解消済み: `syncFile` は `internal: true`
（`runInitSync` の `pushOneFile` 呼び出しからのみ渡す内部専用オプション）を持つときだけ
`_protocolUpgradeRequired` のチェックを迂回する。`syncAll` の init 分岐はグローバルフラグを
一切書き換えず、`runInitSync` が成功して初めて（＝この回で自分が
`FORMAT_CAPABILITY_VERSION`（この client 世代の現行 version）の manifest を書いた＝remote が
既知安全域にあると確定して初めて）`_protocolUpgradeRequired = false` を設定する。外部呼び出し（`syncFileSilent`・
conflict 採用時の直接呼び出し）はこのオプションを渡す経路を持たないため、init の await 中も
グローバルフラグの実値をそのまま見続け、常にブロックされる。回帰テスト:
`src/lib/sync.test.js` の `init 中に外部から syncFileSilent を並行呼び出しすると block
されるが、init 自身の push は通る（#609）`。

**error code**: `sync_protocol_upgrade_required`（HTTP 426。契約の本体は数値ではなく
code。`worker/src/syncErrorCodes.ts` の `CATEGORY_RESPONSE.protocol_upgrade_required`）。
client 側 category は `protocol_upgrade_required`、UI ラベルは「アプリの更新が必要」
（§6 参照）。**このラベルが実際に表示されるのは client 側 gate を持つビルドだけ**である。
本 PR（#609）より前の旧ビルドは `src/lib/syncErrors.js` に
`sync_protocol_upgrade_required` の `CODE_CATEGORY` エントリも 426 の status フォールバックも
持たないため、426 を受け取っても `categorizeSyncFailure` は最終行の既定 `'server'` に落ちる
（Codex レビュー指摘。訂正前の本節は「旧ビルドでも正しく分類される」と誤って記載していた）。
つまり旧ビルドのユーザーには「アプリの更新が必要」ではなく汎用の同期失敗として表示される。
426 を受け取る経路自体も限定的である点に注意（GET 経由では届かず、書き込みが拒否された
瞬間にしか観測されない）。

**既知の制約（#609 A-2 で解消したもの・引き続き残るもの）**:

- ~~manifest revision の比較と再試行を伴う世代 CAS は未実装~~ → **#609 A-2 で実装済み**
  （manifest write の `_sha` 必須化・entity write の `_manifestSha`/entry sha 拘束・
  manifest 409 stale 時の 1 回再試行。次節「entity write の世代拘束と reconcile」参照）。
  orphan entity の回収（GC）・remote 側の entity 削除経路は引き続き未実装（#609 の非目的。
  別 issue）。
- ~~worker は `_sha` の有無そのものを強制しない~~ → **#609 A-2 で解消**。manifest write は
  初回作成を除き `_sha` 必須（不一致・欠落は 409 `sync_manifest_stale`）。entity write は
  `_manifestSha` 必須（欠落は 426 `sync_manifest_ref_required`）。
- `PUT /sync/file/:id` への **worker 側** formatVersion ゲートは **#609 A-2 で実装済み**
  （次節参照。manifest read と同一 request 内で検査するため、旧クライアントの検査すり抜けは
  client 側 `_protocolUpgradeRequired` に依存しない）。`/settings` / `/devices/:id` へは
  引き続き未適用（#609 の対象外。§1 entity kind 表参照。settings は同期対象だが devices は
  同期 identity ではない運用情報）。
- ゲートは repo の default branch にしか及ばない（`repoFile` ヘルパーが ref を受け取らない
  という既存の読み取り経路の性質を、新設したゲートもそのまま引き継いでいるだけで、
  本 PR が新設した制約ではない）。
- `version` フィールドが存在するが型が壊れている場合（`"3"` や `3.5` 等）は欠落時と同じ
  既定値 `2` に倒す。意図的な簡略化であり脆弱性ではない: `manifest.json` の書き込み権限は
  repo owner 自身が既に持つため（[github-boundary.md](../security/github-boundary.md)）。
  将来 v3 実装（#394）が `version` を書く箇所は、必ず JS の整数値として書くこと。
- ~~v3 の実データ定義・移行は #394 の範囲。issue #609 本文が要求する「v3 entity の
  パス空間分離（v2 の `files/{id}.json` と共有しない）」を維持すること~~ →
  **#394 C-1 で設計判断として改訂**。v3 entity のパス空間は分離せず、v2 と同じ
  `files/{id}.json` を継続する。分離の目的（旧 client が v3 データを理解せず誤って読み書き
  しないこと）は **worker の formatVersion ゲート**（`checkFormatCapability` /
  `checkRemoteFormatVersion`。capability 未宣言・不足の write を 426 で拒否する）で代替する。
  分離しない理由: 新しい path space を作ると v2 blob が恒久的に残留し、`hasSyncedEntities`
  の走査対象拡張が必須になる（次項参照）。「revision identity は manifest blob の SHA を
  opaque に使う」は変更なし（#609 A-2 のまま）。
  **既知の制約（受容）**: worker の github-proxy 経由（`worker/src/github-proxy.ts`。
  `.novel-ide` への任意 path の contents PUT を許可する既存の汎用エンドポイント）は、
  `validateGitHubWritePath`（`worker/src/validation.ts`）が `manifest.json` /
  `files/*.json` を拒否しないため、この formatVersion ゲートを経由せず直接
  `manifest.json` 等を上書きできる（#283 以前からの既存経路。#394 C-0 敵対的レビューで
  実測）。脅威モデルはこのゲートを未宣言の旧 client の自動フローが破ることを防ぐものであり、
  proxy 経由の直接 PUT は利用者自身の repo への手動書き込みと同等（`docs/planning/issue-candidates.md` に hardening 候補として提示済み）。
- ~~`KNOWN_SAFE_FORMAT_VERSION` は「version 欠落時の既定値」と「検査を丸ごとスキップして
  よい安全域の上限」を兼ねている~~ → **#394 C-0 で解消**。意味を分離した 3 定数の定義・
  使用箇所は上記「manifest の formatVersion 契約」節を正とする（ここでは再掲しない）。
- ~~entity write（`PUT /sync/file/:id`）は manifest read 直後の formatVersion 判定と
  非同期に進む~~ → **#609 A-2 で解消**。entity write は書き込み直前に worker が
  `manifest.json` を独立に読み直し、`_manifestSha` の一致検査と formatVersion 検査
  （`checkRemoteFormatVersion`）を同一 request 内で行う。別端末が remote を v3 へ更新した
  直後の entity push は、その write が読んだ manifest 世代が古くなっているため
  `_manifestSha` 不一致（409 `sync_manifest_stale`）または formatVersion 超過（426）で
  拒否され、`syncFile` はローカルの `isDirty` を解除しない（write が失敗している以上
  `dbPut` に到達しない）。「読んだ時点は安全域でも書く時点で advance していた」窓は、
  client 側の `_protocolUpgradeRequired` に頼らず worker 側の検査で閉じる。
- ~~`hasSyncedEntities`（worker 側、init の安全確認）は `.novel-ide/files/`（v2 の legacy
  path）しか調べない。v3 実装が entity を別 path space に分離すると検知漏れが生じる~~ →
  **#394 C-1 で解消（v3 は path space を分離しない設計にしたため、走査対象拡張は不要）**。
  v3 でも entity は同じ `files/{id}.json` に住むため、`hasSyncedEntities` は変更なしで
  正しく動く（`worker/src/__tests__/sync.test.ts` の v3 固定テストで確認済み）。

**#394 C-1 で新設した既知の制約**（folder 構造の同期。非目的・受容として明記する）:

- folder を `deleteAll` 相当（配下ごと削除）した場合、配下 file は削除伝搬の対象外
  （非目的。file の削除伝搬は #609 の orphan GC と合わせた別 issue）なので remote に残る。
  他端末がその file を pull すると、folder が既に無いため `repairParentReferences` が
  `parentId` を root（null）へ倒す（「file を消さない」という設計上の安全側の帰結であり、
  利用者からは「削除したはずの章が無題フォルダ配下に復活した」ように見える。
  `docs/planning/issue-candidates.md` に提示済み）。
- badge（`useSyncPending`/`countSyncWork`）は folder 単独の変更を「同期待ち」に出さない
  （folder の canonical hash 対象化を見送った設計判断の帰結。`docs/planning/issue-candidates.md` に提示済み）。
- structure base（`syncState` の合成キー `#structure`）は `src/lib/restore.js` の
  `normalizeSyncStateRecordsForRestore` が `adoptedHash`（文字列）を要求するため、JSON
  バックアップ復元では自然に drop される。復元後は base unknown（3-way merge が union へ
  倒れる。安全側の劣化として意図的に許容する — restore.js のこのレコードへの対応は行わない）。
- `manifest.json` 単体が消失し `files/` の entity だけが残っている場合、worker は
  `hasSyncedEntities` で検知して `sync_workspace_inconsistent` を返し init を拒否する
  （§5 参照）。folder 構造は manifest 内蔵のため、この状態から自動復旧すると folder
  構造は失われたままになる（entity 本体は失われない）。

`fileOrder` フィールド自体は `buildRemoteMap` が検証・正規化して返す（非配列・欠落は
空配列、非文字列要素は除外）ため、「manifest に書かれるだけで読む側が存在しない」という
issue 本文の指摘のうち **形状検証の欠落**は閉じている。ただし、この値を個々のファイルの
表示順（`sortOrder`）へ反映する配線は本 PR には含めない: レビューで、pull されたファイルに
だけ `fileOrder` 由来の `sortOrder`（0..n-1）を付与すると、`sortOrder` を持たない既存の
ローカルファイル（`undefined` → `fileTree.js` の `Number.MAX_SAFE_INTEGER` フォールバック）
より必ず上位に来てしまい、同期のたびに「最近 pull されたファイルが章の並びの上に飛ぶ」
順序の攪乱を引き起こすことが判明した（敵対的レビュー・仕様レビュー由来）。加えて、書き込み
側の `pushManifest` が書く `fileOrder` は現状ローカル配列の格納順であって利用者の表示順
を表さないため、読み取り経由で表示順を制御する前に書き込み側の意味も揃える必要がある。
このため `fileOrder`→表示順の反映は follow-up へ明示的に持ち越す（`docs/planning/issue-candidates.md` に提示済み）。

### entity write の世代拘束と reconcile（#609 A-2）

issue #609 コメント1 が示したデータ喪失シナリオ: 端末 A が空 manifest M0 を確定 → A が
entity X を create-only で書く → 端末 B が M0 を読む（X の entry なし）→ B の通常 push が
X の live SHA を GET して B の本文で上書き → A の本文が失われる。根本原因は、通常 push の
entity write が manifest 世代に拘束されず in-place 上書きだったこと。本節がこの契約を定める。

**契約**:

1. **entity write は必ず「書く側が読んだ manifest 世代」（`_manifestSha`）に拘束される。**
   worker は書き込み直前に `manifest.json` を読み直し、SHA が一致しなければ 409
   `sync_manifest_stale`（category conflict）で拒否する。`_manifestSha` を送らない write は
   426 `sync_manifest_ref_required`（category protocol_upgrade_required。旧 bundle は
   アプリの再読み込みで回復する）。
2. **manifest entry は entity の blob SHA を持つ**（`files[id].sha`。v2 内の追加フィールド。
   旧 client は無視する）。entry に sha があるとき、entity write の `_sha` は entry.sha と
   一致しなければ 409 `sync_entity_stale`（conflict）。＝「snapshot が指す実体」以外を
   上書きしない。`_sha` が entry.sha と一致していても、GitHub 側の CAS write 自体が 409
   （SHA 不一致。並行書き込みの取りこぼし）または 422（blob 消失等）で拒否された場合も
   `sync_entity_stale` に読み替える（#609 round2 F3）。汎用の `sync_conflict` /
   `sync_unprocessable` のままだと client の reconcile 判定（4 参照）に乗らず、stale な
   write が握り潰されて再試行できない。
3. **manifest に entry の無い id、または entry はあるが `sha` フィールドを持たない
   legacy entry への write は create-only**（`_sha` は無視して null 扱い）。worker は事前に
   実在を確認し、実在すれば 409 `sync_entity_orphan`（conflict）。create が GitHub 422 で
   失敗した場合（不在確認と create の間に別端末が作った）も同 code に読み替える。
   **legacy entry は以前 `_sha` を検査せず素通ししていたが、実在確認をすり抜けてしまうため
   #609 round2 F1 で反転し、entry 無しと同じ create-only 経路に倒した。** worker は
   `manifest.files[id]` の索引を own property のみで判定する（`Object.hasOwn`。#609 round2
   F2）: プレーンオブジェクトを `files[id]` で素朴に索引すると、`id` が `__proto__` /
   `constructor` 等のときプロトタイプチェーン経由で継承値が返り、「entry が存在する」と
   誤判定して実在確認をすり抜けてしまう。
4. **reconcile（client）**: `sync_entity_stale` / `sync_entity_orphan` を受けたら live entity
   を GET し、canonical フィールド（`name` / `content` / `github` の owner・repo・branch・
   path のみ。sha は比較しない）が local と同一なら **書かずに採用**（entry sha = live sha、
   `isDirty` を false にして dbPut）。異なれば **conflict** として既存 UI へ（local vs
   remote(live)）。live entity GET が 404（stale/orphan の原因が既に解消されていた。blob
   消失後に別端末が同じ内容で作り直した等）なら、`_reconcile: true, _sha: null` の明示的な
   acknowledge で create-only 書き込みを試み、成功したら採用扱いにする（#609 round2 F3）。
   → 過去の failed manifest PUT が残した正当な orphan（同一端末の再試行）は書かずに採用され
   恒久停止しない。他端末の orphan は conflict になり無検査上書きは起きない。
5. **conflict 解決で local を採用する経路**（`AppContext` の `resolveConflictKeepLocal`）は
   manifest GET → live entity GET → **live の有無に関わらず常に** `_reconcile: true` で書く
   （#609 round2 F4）。`_sha` は live sha（live GET が 404 なら null。この場合 worker は
   create-only で書く）。worker は `_reconcile === true` のとき entry の有無に関わらず
   `_sha` で GitHub CAS のみで書く（`_sha: null` なら create-only。明示的な acknowledge が
   ある write だけが stale/orphan を上書きできる）。**worker は `_reconcile` の真正性
   （client が本当に live GET したか）を検証しない** — 同一信頼境界内（この session の
   `authorizedRepos`）からの明示 acknowledge として受け入れる。
6. **manifest write は初回作成を除き `_sha` 必須**（worker 強制。A-1 は client 側でのみ
   閉じていた）。current が存在するのに `_sha` 無し／不一致 → 409 `sync_manifest_stale`。
7. **snapshot 成立条件は A-1 と同じ**（失敗・conflict を含む回は manifest を書かない）。
   加えて manifest 409 stale のとき `syncAll` は manifest を読み直して pass を **1 回だけ
   再試行**し、それでも stale なら conflict category で終了する（`lastSyncedAt` は
   進めない）。entity write 中に検出した `sync_manifest_stale` も pass 全体を中止して同じ
   再試行に乗せる（1 ファイルの部分失敗として積まない。以後の write もどうせ同じ理由で
   失敗するため）。
8. **entity write route への formatVersion ゲート**（worker）: 1 で読む manifest の
   `version` が既知安全域を超え、request の capability（`X-Novel-Ide-Format-Version`）が
   それ未満なら 426（manifest write の `checkFormatCapability` と同じ判定材料だが、
   entity には「書き込む version」という概念が無いため remote 側の宣言だけを見る簡略版
   `checkRemoteFormatVersion`）。
9. **entity write でも capability header を送る**（#394 C-0 で判断を反転。旧方針は
   「entity write では送らない」だったが、remote が v3 化した瞬間に破れる: entity write の
   formatVersion ゲートは header 未宣言を legacy default（2）として扱うため、
   `_manifestSha` 拘束で読んだ remote が既に v3 なら legacy default(2) &lt; 3 で 426 になり、
   **新 client 自身の entity write も含めて全端末の同期が恒久停止する**（旧方針のまま
   version を 3 へ上げると即座に発火する自己ロックアウト）。旧 Worker の preflight 拒否
   という当初の懸念（上記「header 送信ルート」参照）は、#609 A-2 以降 entity write 自体が
   `_manifestSha`/`_sha`/`_reconcile` を常時送るため Worker-first 配備が実質必須という
   前提の上でしか発火しない。すなわちこの懸念が現実になる配備順（旧 Worker が新しい
   entity write body を先に受け取る順序）は既にこの契約自身が禁止しているため、header
   送信の拡張が新たな preflight リスクを持ち込むわけではない。
10. **pull は live を採用し live `_sha` を entry に記録する**（読み取りは破壊しないため
    snapshot との不一致でも停止させない。停止させると stale 側が永久に pull できなくなる）。
11. **legacy entry（sha なし）**: manifest entry はあるが `sha` フィールドが無い（この契約
    より前に書かれた manifest）場合の client 側の扱いは push/skip で異なる（#609 round2
    F1/F4）。
    - **push**: live GET で補完**しない**。`_sha: null` を送る（worker は 3 の create-only
      経路で判定するため、client が正確な expected sha を当てる必要が無くなった。実在すれば
      409 `sync_entity_orphan` → 4 の reconcile が live を採用/conflict へ倒す）。
    - **skip**: 一度だけ live GET で補完し、次の snapshot から sha 付きにする。live GET が
      404（entry はあるが entity が無い drift）なら、sha 無し entry を manifest に書き戻さず
      **push（create-only）対象として扱う**。補完 GET に失敗した file はその回の snapshot を
      不成立にする（件数に比例する一回限りのコスト。旧 client が manifest を書き戻すと sha
      が落ちるが、次の新 client の snapshot で再補完される。legacy entry を持つ利用者が多い
      間は毎回の再補完が trees API 1 回のバッチ取得に置き換えられる余地がある。
      `docs/planning/issue-candidates.md` に最適化候補として提示済み）。
12. **autosave（`syncFileSilent`）**: 直近の `syncAll` が読んだ manifest sha と entry sha を
    module 内 `_snapshotRef` に保持して使う。未取得（`syncAll` が一度も成功していない）なら
    通信せず null を返す（best-effort。stale はサイレントに失敗し次回 `syncAll` が拾う）。
    成功したら `_snapshotRef.entries[id]` を新しい sha へ更新する。

**新設した code**（category は既存の conflict / protocol_upgrade_required を再利用し、code
だけを区別する。`worker/src/syncErrorCodes.ts` の `CONFLICT_RESPONSE` /
`PROTOCOL_UPGRADE_RESPONSE`、client 側は `src/lib/syncErrors.js` の `SYNC_ERROR_CODES` /
`CODE_CATEGORY`）:

| code | status | category | 意味 |
|---|---|---|---|
| `sync_manifest_stale` | 409 | conflict | entity/manifest write が読んだ manifest 世代から進んでいた |
| `sync_entity_stale` | 409 | conflict | manifest entry の sha と write の `_sha` が不一致 |
| `sync_entity_orphan` | 409 | conflict | entry の無い id への write で entity が実在した（create-only 違反） |
| `sync_manifest_ref_required` | 426 | protocol_upgrade_required | entity write が `_manifestSha` を送っていない（旧 bundle） |

**旧 bundle の扱い**: `_manifestSha` を知らない旧 client の entity write は 426 になる。UI は
既存の `sync_protocol_upgrade_required` と同じ「アプリの更新が必要」文言・再読み込み導線を
再利用する（category が同じ `protocol_upgrade_required` のため、`CATEGORY_MESSAGE` の文言・
`CATEGORY_PRIORITY` の優先順は追加不要）。

**実装の所在**: §7「実装の所在」の #609 A-2 各行を正とする（ここでは再掲しない）。

**残余（この PR の範囲外）**: settings/devices への entity write 世代拘束・worker 側
formatVersion ゲートは対象外（§1 entity kind 表参照）。orphan entity の GC・remote 側の
entity 削除経路は未定義（別 issue）。legacy entry の live GET 補完を GitHub trees API の
1 回のバッチ取得へ置き換える最適化は上記 11 のとおり follow-up。

### GitHub 上の 2 つの保存先

| 保存先 | 役割 |
|---|---|
| 作品リポジトリ（`files.github.owner/repo/branch/path`） | 人間・外部ツールから読める Markdown 本文側の正本 |
| `.novel-ide` | novel-ide の cross-device workspace state store（未 commit 本文・構造・metadata 等） |

**この 2 つを同じ「GitHub 保存済み」状態として扱わない。**

## 2. データ分類

| 分類 | 項目 |
|---|---|
| **A. cross-device canonical identity** | `files.{id,name,content,parentId}`（**parentId は #394 C-1 で実装済み**。manifest `files[id].parentId` を transport とし entity 本体には含めない） / `files.github.{owner,repo,branch,path}` / `folders.{id,name,parentId,sortOrder}`（**#394 C-1 で実装済み**。manifest `folders` dict） / manifest `fileOrder` / `fileMetadata.{fileId,workId,title,kindId,statusId,tagIds,custom}` / `folderMeta.{folderId,workId,kindId,title}` / `kindDefinitions` / `statusDefinitions` / `customFieldDefs` / `workSettings.{id,label,githubRepoPath}` / `annotations` / `settings.settings.replacementProfiles` / `settings.rules` / `settings.tags` / `settings.wgoal` / `settings.wgoalsByFile` / `settings.wgoalsByFolder` |
| **A2. replicated auxiliary metadata** | 各 entity の `createdAt` / `updatedAt`（**folder の `createdAt` は #394 C-1 で structure〔manifest `folders` dict〕に載せて 3-way merge の 1 フィールドとして運ぶが、file と同様 hash 対象にはしない**） |
| **B. derived** | `files.github.sha`（remote concurrency state。別端末へ同期しない） / `files.security.*` / `meta.migrated_*` |
| **C. device-local** | `theme` / `sidebarSide` / `showLineNumbers` / `colors` / `splitSwapped` / `settings.settings.write` / `settings.settings.preview` / `settings.settings.notifications.*` / `settings.settings.github.commitMessage` / `meta.ghUser` / `meta.deviceId` / `wordCountMode` / `ghOpenTarget` |
| **D. ephemeral** | `meta.{fid,secondaryFid,splitOpen,activePane}` / `files.isDirty` / `fileMetadata.isDirty` / `meta.lastSyncedAt` / `styleCheckStore.*` |

`settings` ストア全体を同期対象にはしない。A に列挙した allowlist のみが canonical。

### A2 を canonical identity の hash 対象にしない理由

`createdAt` / `updatedAt` は remote payload に載せてよいが、**同一性 hash の入力には含めない**。
含めると、次の理由で「意味は同じなのに未同期」と判定されうる。

- 端末間の clock skew
- 時計の巻き戻し
- 同一ミリ秒

したがって契約は次のとおり。

- **timestamp だけの変化は sync work を発生させない。** timestamp を更新するためだけの同期は発生しない。
- 他の canonical identity の差分によって entity が転送される場合には、`createdAt` / `updatedAt` も
  **付随して転送される**。

**file entity について実装済み**（#610 B）。`src/lib/sync/identity.js` の
`canonicalSerialize` / `computeCanonicalHash` が `files.{id,name,content,github.{owner,repo,
branch,path}}` を対象に SHA-256 hash を計算し、同ファイルの `deriveSyncAction` が
`localHash` / `remoteHash`（manifest entry の `hash`）/ `adoptedHash`（IndexedDB `syncState`。
`docs/data-model/INVARIANTS.md` #3 参照）から push/pull/skip/conflict を決める。
`resolveClassification` / `countSyncWork`（`src/lib/sync.js`）はこの hash を入力とし、
`updatedAt` の時刻比較は行わない。除外規則（remote SHA / timestamps / sync bookkeeping / device-local /
ephemeral）と、その帰結（timestamp だけの変化は sync work を発生させない・編集後に内容が
完全に元へ戻れば「同期済み」）は `src/lib/sync/identity.test.js` / `src/lib/sync.test.js` で
固定している。

folders / fileMetadata 等、上表 A 分類のうち file 以外の entity の **hash（`computeCanonicalHash`）
対象化**は未実装（#394 / #611）。**folder / `files.parentId` は #394 C-1 で同期対象化した
（上表参照）が、canonical hash（push/pull/skip/conflict の判定式）には含めない**——file の
hash 式を変えると既存 file 全件の `adoptedHash` が旧式化し conflict 表示を誘発するため、
structure（folder・parentId）は hash とは別の 3-way merge（`src/lib/sync/structure.js`）で
判定する（「v3 manifest の形状」節参照）。現状、canonical **hash** 判定の対象は file entity
のみ（structure は別の判定式を持つ、という意味）。

**残余の制約（#610 round2）**:

- `crypto.subtle` が使えない環境（非セキュアコンテキスト等）では、hash 計算に依存する全 file
  が `internal` category の失敗として数えられ、同期が進まない（manifest を書かない・
  badge は pending のまま）。この失敗は一時的な通信障害と文言上区別しない — secure context
  （HTTPS。`crypto.subtle` が利用可能）であることを前提とする。この前提が崩れる環境固有の
  案内は本契約の対象外。
- DB v4 移行直後（`syncState` が空）は、entry.hash を持たない legacy manifest の file ごとに
  live GET で 1 回 hash を補完する（`resolveClassification`）。この補完は file 単位の
  fail-closed であると同時に、pass 全体は all-or-nothing で成立する — 1 件でも hard failure
  （GET 失敗・hash 計算失敗）があれば、他の file が成功していても manifest は確定しない
  （§1「同期完了」の snapshot commit 判定を継承。#625 から変更なし）。

### `files.github` はフィールド単位で分かれる

`owner` / `repo` / `branch` / `path` は「この本文がどの作品リポジトリ上の何に対応するか」という
作品側の論理情報なので canonical。`sha` は remote concurrency state であり derived で、
別端末へ同期しない。

## 3. 同期された GitHub 座標は認可ではない

**`owner` / `repo` / `branch` / `path` が同期されてきても、その端末で書き込みが認可されたことを
意味しない。**

受信端末では常に **untrusted input** として再評価し、その端末の worker session の
`authorizedRepos` 等による再認可を経る（[github-boundary.md](../security/github-boundary.md) §3 の
既存境界を維持する）。

同期が運ぶのは「**どこに対応しているか**」だけであり、「**そのリポジトリを触ってよい**」という
権限は運ばない。

## 4. エラー意味論

### 原則

GitHub upstream の失敗は、**status / category を失わないまま** worker route を通り client へ届く。

```
GitHub upstream error
  → status/category を保持した typed error（worker/src/syncErrors.ts）
  → worker route（stable code つき JSON）
  → client（src/lib/syncErrors.js で category へ復元）
  → 用途別表示
```

- 分岐条件は **stable な machine-readable code** であり、HTTP status 単体ではない。
  同じ status に複数の意味が乗るため（404 の repo 不在 / content 不在が典型）。
- GitHub のレスポンス本文（`message`）は client へ透過しない。
- **worker の応答本文（`error`）を client の表示文言へ転用しない。** sync route 以外の
  ミドルウェア応答（`unauthorized` / `session expired` / `csrf token invalid` 等の内部英語
  文字列）も同じ fetch 経路を通るため、本文をそのまま表示に載せると日本語 UI に露出する。
  worker の `error` は**応答本文をそのまま描画する消費者**（`DevicesMod` の削除失敗表示）
  向けの事実文、client の `CATEGORY_MESSAGE` は行動指示を含む UI 文言、と役割を分ける。
  文言は一致させないが、**category 集合の一致**は parity テストで機械検査する。
  ⚠️ 既知の例外（A-1 では未修正）: `DevicesMod` は `body.error` をそのまま `window.alert` に
  出すため、セッション切れ時に `削除に失敗しました: unauthorized` のように英語本文が出る。
  同じく `src/lib/workerClient.js` は `body.error === 'csrf token invalid'` の**英語文字列一致**で
  再試行を分岐しており、「分岐条件は stable code」の原則の例外が同一 fetch 経路に残っている。
- `msg === 'GitHub 409'` のような**文字列一致による status 復元は禁止**。

### client 側の例外（fetch と応答形状）

`network` は **fetch の拒否だけ**を意味する。fetch 拒否は `workerClient` の境界で
`SyncRequestError('network')` に型付けし、`categorizeThrown` は `TypeError` を network の判定条件に
**使わない**。`TypeError` は応答形状の不正（HTTP 200 で `null` が返る等）や実装上のプロパティ
アクセス失敗でも出るため、型で分類すると恒久的な破損が「通信障害」として集計・表示され、
remote / client の破損が誰にも気づかれない。応答が返っている以上は通信は成立しており、
`corrupt`（remote 側の破損）か `internal`（client 側の整合性・実装）に分類する。

### upstream status → category

| upstream | category | client へ返す status | code |
|---|---|---|---|
| 401 | auth | 401 | （`revokeSessionIfTokenInvalid` の既存経路。#288） |
| 403 | forbidden | 403 | `sync_forbidden` |
| 404 | not_found | 404 | `sync_repo_missing` / `sync_manifest_missing` / `sync_content_missing` |
| 409 | conflict | 409 | `sync_conflict` |
| 422 | unprocessable | 422 | `sync_unprocessable` |
| 429 | upstream（GitHub API のレート制限。「待てば直る」側であり `server` には潰さない） | 502 | `sync_upstream_error` |
| 5xx | upstream | 502 | `sync_upstream_error` |
| その他 | server | 500 | `sync_server_error` |

**422 を status だけ見て conflict と判定しない。** 422 は検証・処理不能を表す。特定の 422 を
concurrency failure として扱う必要が生じた場合は、GitHub レスポンスの具体的な内容を根拠に
限定して分類する（status だけを根拠にしない）。

code 集合は client / worker で一致していなければならない
（`src/lib/syncErrorCodeParity.test.js` が機械検査する）。

### 404 の細分

`GET /sync/manifest` の 404 は 2 種類あり、区別しないと復旧経路が壊れる。

| code | 意味 |
|---|---|
| `sync_repo_missing` | `.novel-ide` リポジトリが存在しない |
| `sync_manifest_missing` | リポジトリはあるが `manifest.json` が存在しない |

**不在ではない失敗（403 / 5xx / 未知）を 404 に潰さない。**

`GET /sync/file/:id` / `GET /sync/settings` の 404 は細分せず `sync_content_missing` を返す。
これらの 404 は意味が 1 つ（対象の entity が remote に無い）しかなく、client 側の分岐も
「新規ファイルなので expected SHA なし」という 1 通りに定まるため、status だけで分岐してよい。
細分が要るのは `GET /sync/manifest` のように、**同じ 404 が別の復旧動作へ分岐する**場合だけ。
ただし 404 応答そのものは全経路で code を持たせ、「404 は code つきで返す」規約に例外を作らない。

## 5. init（初回同期）の安全性

`runInitSync` は local の全ファイルを**分類なしで push する破壊的経路**である。したがって
突入条件は fail-closed とする。

- init に入ってよいのは、`GET /sync/manifest` が **`sync_repo_missing` または
  `sync_manifest_missing` を返したとき**だけ。`sync_manifest_missing` は「manifest が無く、
  かつ `files/` に entity が 1 つも無い」ことを worker 側で確認したうえで返す。entity が
  あるのに manifest が無い状態は `sync_workspace_inconsistent` として区別し、**init に
  入らない**（manifest だけを失った workspace を全件 push で上書きしないため）。
- code がない 404・未知 code の 404・本文が JSON でない 404・403・5xx では **init に入らない**。
  一時的な取得失敗を「remote に何も無い」と誤認すると、remote の新しい内容を上書きしうる。
- manifest の write で expected SHA を省略できるのは、**上記で不在を確認した初回作成のみ**。
  `POST /sync/init` は repo を作成した場合 `manifest.json` も書くため、「init 経路だから
  create」と決め打たず、init 後に remote を読み直して expected SHA の有無で判断する。
- **現時点では未達**（#609 A-2 で満たす）: この create 意図の要求は **client 側にしかない**。
  worker の `PUT /sync/manifest` は `_sha` の有無を検査せず GitHub へ渡すため、旧バンドル・
  別クライアント・直接リクエストは expected SHA なしで write できる（実害は GitHub 側の
  create-only 制約が受け止めている）。worker 側での CAS 強制は A-2 の範囲。

init が既存の manifest を上書きしてよいのは、**その同期の `POST /sync/init` が repo を新規作成し、
かつ読み取った manifest が空のまま**（= 今 init が作った初期 manifest）のときだけ。repo が既に
あった場合、または manifest が既に entry を持つ場合は、それが他端末のものでありうるため
**上書きせず中止する**（次回の通常同期が manifest ありの経路で突き合わせる）。`repoCreated`
だけを根拠にしないのは、init 直後・manifest 読み取りまでの間に別端末がその空 manifest を基に
通常同期を完了しうるため。

**init の entity push は create-only。** manifest の事前確認から個々の push までの間に別端末が
同じ id の entity を作る窓が残り、そこを上書きすると別端末の本文が失われる（manifest の CAS は
index しか守らない。entity write の世代検査は #609 の範囲）。init では remote に entity が既に
あれば上書きせず `workspace_inconsistent` で中止する。窓は不在確認の **前後の両方**にあるため、
中止する条件は 3 つ:

1. 不在確認で entity が実在した（`workspace_inconsistent`）
2. 不在確認そのものが失敗し、不在を確認できなかった（403 / 5xx / 通信断等）
3. SHA なしの create 書き込みが失敗し（**理由を問わない**。PUT 自体の reject を含む）、その後の
   再確認が「明示的な 404」を返さなかった ＝ 不在確認と書き込みの間に別端末が同じ id を
   作った可能性が残る

条件 3 の判断基準は PUT の失敗理由（status / category）の列挙ではなく、**常に再確認したうえで
absence を明示的な 404 で証明できたか**の一点に一本化する。GitHub の 422 は create-only 違反
（sha 省略での既存ファイル更新）だけでなく一般の validation failure でも返るため status だけを
実在の確証にできないし、429 / 5xx / 通信断も「entity を作れなかっただけの安全な失敗」と決めつけ
られない（別端末が並行してその entity を作っている可能性は消えない）。**不在は明示的な 404 でだけ
確定する**。確認不能を不在と同じに扱うと、実際には別端末の entity が存在していても entry を
欠いた manifest が確定し、次回の通常同期がその entity を上書きする。書き込みが拒否されている
時点では上書きは起きないが、危険なのは**次回の同期**。この規則は push 前の不在確認・create
書き込み失敗後の再確認の両方に、失敗理由を問わず適用する。

条件 3 の再確認で absence を明示的な 404 で確認できた場合は、その entity だけを通常の部分失敗
として扱う（不在は確認済みで上書きの危険がなく、1 ファイルの検証エラーや一時障害のたびに
init 全体が毎回中止すると正常な他ファイルが一度も snapshot に載らなくなる）。条件 1〜3 の
いずれかで中止する場合は、**部分失敗ではなく init 全体の中止**で、manifest は書かない: 衝突した
id を欠いた manifest を確定させると、次回同期ではその id が manifest に無い＝push と判定され、
create-only 制約を持たない通常経路が別端末の entity の SHA を取得して本文を上書きする。中止
しても、空 manifest は entity push の前に確定済みなので恒久停止しない（次回は通常同期の経路で
回復する）。

**init 中に entity の *書き込み* が一部失敗した場合は（不在は確認済みで上書きの危険がない）、
push に成功した entity だけを載せた manifest を書く。** 全件成功していないことを理由に manifest を書かずに終えると、remote は「entity はあるが
manifest が無い」状態になり、次回以降は `sync_workspace_inconsistent` が返って init に再突入
できず**恒久停止する**。成功分だけの manifest は remote の実体と一致した snapshot であり、
manifest が指すのに存在しない entry も作らない。未 push の分は次回の通常同期が push する
（この回は snapshot 未完了なので `lastSyncedAt` は進めない）。

完全な CAS 契約（manifest revision の比較と再試行）は #609（A-2）で定義する。A-1 では
「expected SHA なしの無条件書き込み経路を塞ぐ」ところまでを契約とする。

### manifest の生成規則（A-1 で追加）

- `files` は **dict 必須**。欠落・配列・文字列は壊れた manifest として扱い、読み側は
  `corrupt` で停止し、書き側（client / worker とも）は書き込みを拒否する。欠落を「空」と
  解釈すると、remote が空に見えて全件 push へ倒れ、他端末の entry を一掃したうえで
  「同期済み」と表示してしまう。
- `folders` も **v3（`version>=3`）では dict 必須**（#394 C-1 round3 item13）。v3 を宣言し
  ながら `folders` が欠落・非 dict なのは手編集等の破損でしか生じない（worker が v3 write で
  同じ形状を要求するため正規の v3 manifest では常に dict）ので、`files` と同様に読み側は
  `corrupt` で停止し manifest を書かない。**v2（`version<3`）で `folders` キー自体が無いのは
  正規の未移行状態**であり、これは corrupt にせず unknown（missing ≠ empty）として local を
  保持する。
- **隔離ファイル（#291）の entry は remote manifest から引き継ぐ**（`carryOver`）。隔離
  ファイルは同期対象のリストに入らないため、引き継がないと「完全成功」の snapshot から
  entry が消え、全端末のファイル一覧から見えなくなる。引き継ぐ際は **隔離 id をキーの正**と
  し、既知フィールド（`id` / `name` / `updatedAt` / `github`）だけを取り出して再構築する
  （remote の entry は key と独立に `id` を名乗れるため、そのまま書き戻すと無関係の
  ファイルの entry を上書きでき、しかも自分で書き戻すので汚染が永続化する）。
- init が manifest の write 先（更新か新規作成か）を決めるのは **entity を push する前**。
  push した後に remote を読むと、自分が作った entity のせいで entity 実在確認が必ず true に
  なり、新規作成の分岐へ到達できなくなる（manifest を永久に書けず、以後すべての端末の
  すべての同期が `sync_workspace_inconsistent` で停止する）。

### A-1 時点で残る既知のリスク（対応先を明示する）

| リスク | 状態 | 対応先 |
|---|---|---|
| 応答本文を書き換えられる中間層（侵害された SW / プロキシ）が `code` を差し替えて init を誘発できる | **受容**。同じ能力があれば 200 で `files: {}` の manifest を返して全件 push を誘発でき、init 経由は追加の能力を与えない。防御は応答の完全性（HTTPS・same-origin）であって code の解析ではない | — |
| `manifest.json` と `files/` が同一 replica の stale read で同時に 404 になると、entity 実在確認をすり抜ける | **対応済み（#609 A-2）**。entity write は書き込み直前に読み直した manifest への `_manifestSha` 拘束と、entry 実在確認（create-only 分岐）を同一 request 内で行う。stale read で両方が同時に 404 になる窓は依然理論上残るが、その場合は manifest 自体が読めず fail-closed（`sync_manifest_missing`）で entity を書かない | #609（対応済み） |
| manifest が指す entity が remote から消えていると、pull が毎回失敗して snapshot を成立させられない | **fail-closed で可視**。失敗として表示され、データは失われないが自動復旧しない。manifest と entity の突き合わせ（reconcile）が必要 | #609（範囲外。GC と合わせて別 issue） |
| orphan entity の回収（GC）・remote 側の entity 削除経路が無い | **未着手** | #609 の非目的（別 issue） |
| 通常同期の push が manifest 世代に拘束されていない。空 manifest M0 を読んだ端末 B が、M0 に entry の無い entity（別端末 A が create-only で書いた直後のもの）の SHA を取得して自分の本文で上書きできる | **対応済み（#609 A-2）**。entry の無い id への write は create-only（`_sha` 無視）にし、実在すれば 409 `sync_entity_orphan` で拒否。reconcile（同一内容なら採用・異なれば conflict）を同時に定義したため、既存の orphan entity を持つ利用者の同期も恒久停止しない。「entity write の世代拘束と reconcile」節（本ファイル §1）参照 | #609（対応済み） |
| worker 側に expected SHA の強制が無い（client 側でのみ閉じている） | **対応済み（#609 A-2）**。manifest write は `_sha` 必須（不一致は 409 `sync_manifest_stale`）、entity write は `_manifestSha`/entry sha 必須（不一致は 409 `sync_entity_stale`）を worker が強制する | #609（対応済み） |
| 同期判定が `updatedAt` の時刻比較のままで、409 後の再同期が安全である条件が定義されていない | **対応済み（#610）**。`resolveClassification` / `countSyncWork` は canonical hash 入力のみで判定し、`updatedAt` を読まない | #610（対応済み） |

## 6. UI 状態と同期状態の対応

`SyncBadge` が出す利用者可視ラベルと、その判定入力。**#610 で「同期待ち」の判定を
`files.isDirty` から canonical hash 比較へ移した**（§1 が `isDirty === false` を同期完了の
定義から外しているため、`isDirty` ベースのまま残すと §1 が否定した基準が UI に残ることになる）。

| ラベル | 判定入力 | 意味 | 利用者の次の行動 |
|---|---|---|---|
| オフライン | `isOnline` | 通信不可 | 回線の回復を待つ |
| 競合あり | `conflictData` | 本文が local / remote で食い違う | 競合 UI で解決する |
| 同期中 | `status.isSyncing` | 実行中 | 待つ |
| （失敗系。ラベルは `errorCategory` 別） | `status.errorCategory` | §4 の category（`protocol_upgrade_required` を含む。§1 参照） | category ごとに異なる（`CATEGORY_MESSAGE`） |
| 同期待ち | `hasPendingChanges`（`useSyncPending` フック。`sync.js` の `resolveClassification` と単一の導出関数 `deriveSyncAction` を共有する） | 未転送の変更がある（canonical hash が remote/adopted と不一致） | 同期する |
| 最終同期時刻 | `status.lastSyncedAt` | **snapshot が成立した**回のみ更新。起動時に `meta.lastSyncedAt` から 1 回読んだ値を初期値にする（#610。リロード後も表示が空にならない） | — |

`lastSyncedAt` は snapshot が成立した回だけ進める。失敗が残る回でも進めると、リロードで
`error`（メモリのみ）が消えたあとに緑の最終同期時刻だけが残り、未転送データがあるのに
「同期済み」に見える（false 同期済み）。

`switchBranch`（AppContext）の未保存警告（`f.isDirty` を見て確認ダイアログを出す）は本節の
「同期待ち」表示とは別の関心事（ブランチ切替でエディタの未保存編集が失われる、という
saveStatus 側の懸念）として、`isDirty` を判定に使い続けてよい。#610 が置き換えるのは
「remote と未同期か」の判定だけであり、「ローカルの未保存編集があるか」の判定ではない。

## 7. 実装の所在

| 関心事 | 実装 |
|---|---|
| upstream typed error / code / route 応答 | `worker/src/syncErrors.ts` |
| worker route への適用 | `worker/src/sync.ts` |
| client の category 復元・表示文言 | `src/lib/syncErrors.js` |
| init 突入判定・manifest create 意図・snapshot commit 判定 | `src/lib/sync.js` |
| manifest の生成（現行 schema: `version`(3) / `fileOrder` / `files[id].{id,name,updatedAt,github,sha?,hash?,parentId?}` / `folders`） | `src/lib/sync.js` の `pushManifest` |
| v3 structure（folders dict + files[id].parentId）の読み取り正規化・3-way merge（#394 C-1） | `src/lib/sync/structure.js` の `parseRemoteStructure` / `readBaseStructure` / `mergeStructure` |
| structure base（syncState の合成キー `#structure`）の読み書き・hydrate ゲート（`filesLoaded && foldersLoaded`）・merge 結果の manifest/base への反映 | `src/lib/sync.js` の `resolveStructureForPass` / `runSyncCycle` / `runInitSync` / `writeStructureBase` |
| structure の local 適用（merge の明示差分の id 単位 patch・レコード単位の楽観的検証〔F1〕・folders/files の repair・IDB 差分書き込み・folderMeta/orphan workSettings 掃除） | `src/lib/sync/applyStructure.js` の `applyStructure`（`localSnapshot` 引数で merge の local 入力を受け取り、ライブ値との一致を検証。`repairParentReferences` を再利用。`cleanupOrphanedFolderMeta` を `AppContext.jsx` の `deleteFolder` とも共有）。呼び出し元: `src/context/AppContext.jsx` の `applyStructureFromSync`（I/O を注入する薄い wrapper）／`src/lib/sync.js` の `resolveStructureForPass`（`localSnapshot` を渡す） |
| remote unknown × local folders 空のときの structure 書き戻し抑止（F2） | `src/lib/sync.js` の `resolveStructureForPass`（早期 return）・`structureForUnknownRemote`（`rawFoldersOverride`/`omitFolders`/`versionOverride`）・`pushManifest` |
| pull の部分更新（github.sha は local 保持、createdAt は無効なら local 保持、parentId は entity payload に無いため local から引き継ぐ） | `src/lib/sync.js` の `mergePulledGithub` / `applyPulledCreatedAt` / `applyLocalParentId` / `parseRemoteFile`。`applyLocalParentId` は `AppContext.jsx` の `resolveConflictRemote` / `resolveConflictBoth` とも共有 |
| worker PUT /sync/manifest の v3 形状検証（files・folders 両方 dict 必須）・POST /sync/init の bootstrap manifest version | `worker/src/sync.ts` |
| canonical hash（同一性判定の入力）・除外規則・同期アクション導出（#610） | `src/lib/sync/identity.js` の `canonicalSerialize` / `computeCanonicalHash` / `deriveSyncAction` |
| syncState（adoptedHash。IndexedDB v4。#610） | `src/lib/db.js`（ストア定義） / `src/lib/sync.js`（読み書き。`resolveClassification` / `writeAdoptedHash` / `markAdopted`） |
| badge の「同期待ち」判定（`resolveClassification` と同じ導出関数を共有） | `src/hooks/useSyncPending.js` |
| manifest の形状検証（読み: corrupt 判定 / 書き: 400 拒否） | `src/lib/sync.js` の `buildRemoteMap` / `worker/src/sync.ts` の `PUT /sync/manifest` |
| remote 由来辞書の null-prototype 正規化（INVARIANTS #11） | `src/lib/sync.js` の `buildRemoteMap` |
| formatVersion の解釈・既知安全域判定（#609 A-2） | client: `src/lib/sync.js` の `parseFormatVersion` / `buildRemoteMap` / `syncAll`。worker: `worker/src/sync.ts` の `parseFormatVersion` / `checkFormatCapability` |
| `sync_protocol_upgrade_required`（426）の定義・応答 | 定義: `worker/src/syncErrorCodes.ts` の `CATEGORY_RESPONSE.protocol_upgrade_required`。throw: `worker/src/sync.ts` の `checkFormatCapability` が `ProtocolUpgradeRequiredError` を throw。応答化: `worker/src/syncErrors.ts` の `syncErrorResponse` |
| fileOrder の形状検証（表示順への反映は follow-up。上記参照） | `src/lib/sync.js` の `buildRemoteMap` |
| entity write の formatVersion 中止フラグ（`syncAll` の中止を `syncFile` 全経路へ波及） | `src/lib/sync.js` の `_protocolUpgradeRequired` / `syncFile` |
| formatVersion の意味を分離した 3 定数（#394 C-0） | 定義: `worker/src/syncErrorCodes.ts`（正）/ `src/lib/syncErrors.js`（写し）の `LEGACY_DEFAULT_FORMAT_VERSION` / `KNOWN_SAFE_FORMAT_VERSION` / `FORMAT_CAPABILITY_VERSION`。parity: `src/lib/syncErrorCodeParity.test.js`。capability header の送信値としての消費: `src/lib/workerClient.js` の `setCapabilityHeaderIfRequested` |
| UI ラベル | `src/components/header/SyncBadge.jsx` |
| code 集合・category 集合・往復の client/worker parity | `src/lib/syncErrorCodeParity.test.js` |
| entity write の世代拘束（`_manifestSha`/entry sha 検査・create-only・reconcile 判定） | worker: `worker/src/sync.ts` の `PUT /sync/file/:id` / `checkRemoteFormatVersion`。応答: `worker/src/syncErrorCodes.ts` の `CONFLICT_RESPONSE` / `PROTOCOL_UPGRADE_RESPONSE`、`worker/src/syncErrors.ts` の `syncConflictResponse` / `syncProtocolUpgradeResponse` |
| manifest write の `_sha` 必須化（CAS） | `worker/src/sync.ts` の `PUT /sync/manifest`（`checkFormatCapability` が返す `current` を使う） |
| client 側 entity write の単一 choke point（`_manifestSha`/`_sha`/`_reconcile` 送信） | `src/lib/sync.js` の `syncFile` |
| entry sha の解決（push は GET しない `resolveEntrySha`、skip は legacy の live GET 補完と drift 検出 `resolveClassification`〔#610 で `resolveSkipLegacySha` を統合〕）・reconcile 判定（stale/orphan、live 404 は create-only 再 write）・snapshot 保持 | `src/lib/sync.js` の `resolveEntrySha` / `resolveClassification` / `reconcileEntityWrite` / `_snapshotRef` |
| manifest entry の `sha` 出力・pull 時の transport フィールド（`_` 始まり）除去 | `src/lib/sync.js` の `pushManifest` / `parseRemoteFile` |
| conflict 解決で local を採用する経路（reconcile write） | `src/lib/sync.js` の `resolveConflictKeepLocal`（呼び出し元: `src/context/AppContext.jsx` の `resolveConflictLocal`） |
| manifest 409 stale の 1 回再試行 | `src/lib/sync.js` の `syncAll` / `runSyncCycle` |
