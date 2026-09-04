# 信頼境界リファレンス

novel-ide における「信頼できない入力」の定義・分類・バリデーション適用箇所をまとめる。
後続 issue (#147〜#151) の実装者はこのドキュメントを参照し、追加する機能が信頼境界を適切に扱っているか確認すること。

---

## 信頼レベル定義

| レベル | 説明 |
|--------|------|
| **TRUSTED** | アプリ内部で生成した値（`Date.now()`, ハードコードされた定数等） |
| **UNTRUSTED** | ユーザーが直接入力した値、IndexedDB から読み込んだ値、ブラウザから来る値 |
| **EXTERNAL** | GitHub API・外部サービスのレスポンス（ユーザーが操作可能なリポジトリの内容を含む） |

> **原則**: UNTRUSTED / EXTERNAL の値はシステム境界を越える前に必ずバリデーション・正規化を通す。

---

## 入力源別マッピング

### ユーザー直接入力（UNTRUSTED）

| 入力 | バリデーション | 適用箇所 |
|------|--------------|---------|
| ファイル名 | `sanitizeFileName()` | `AppContext.jsx:createFile`, `renameFile` |
| フォルダ名 | `sanitizeFileName()` | `AppContext.jsx:createFolder`, `renameFolder` |
| 原稿本文 | React text node として描画（XSS なし） | `WriteMode.jsx`, `PreviewMode.jsx` |
| コミットメッセージテンプレート | `validateCommitMessage()` — 長さ500・null byte・Bidi 禁止 | `AppContext.jsx:buildCommitMessage` |
| カスタムフィールド値 (text/number/date/url/select) | `normalizeCustomFieldValue()` — 型強制・長さ制限 | `fileMetadataStore.js`, `normalizeFileMetadata.js` |
| カスタムフィールド URL | `validateUrl()` / `sanitizeUrlForExport()` | `normalizeFileMetadata.js`, `serializeMetadataForGit.js` |
| GitHub リポジトリパス (githubRepoPath) | `validateWorkspaceRootPath()` — パストラバーサル・禁止パス | `validateWorkspaceSettings.js` |
| タグ名 | React text node として描画 | `TagMod.jsx` |
| アノテーションノート | 長さ制限 (MAX_NOTE_LENGTH=5000) | `annotations.js` |

### IndexedDB（UNTRUSTED — DevTools 改ざん想定）

| データ | バリデーション | 適用箇所 |
|--------|--------------|---------|
| `files` レコード全フィールド | `normalizeFileRecords()` — id 形式検証・型強制・github 参照の allowlist 抽出（#282） | `filesStore.js:hydrate` |
| `fileMetadata` 全フィールド | `normalizeFileMetadata()` — 型強制・ID 検証・フォールバック | `fileMetadataStore.js:hydrate` |
| `kindDefinitions` / `statusDefinitions` | `normalizeKindDefinition()` / `normalizeStatusDefinition()` | `fileMetadataStore.js:hydrate` |
| `customFieldDefs` | `typeof d.id === 'string' && typeof d.label === 'string'` フィルタ | `fileMetadataStore.js:hydrate` |
| `folders` レコード | **未正規化**（正規化追加は監査 follow-up。ツリー構築側に cycle guard あり） | `foldersStore.js:hydrate` |
| `annotations` レコード | `normalizeAnnotations()` — 配列型ガード + per-item 正規化（位置クランプ・型強制）+ 不正要素の除外 | `useAnnotations.js`（`dbGet('annotations')` 直後） |

### GitHub API レスポンス（EXTERNAL）

| データ | バリデーション | 適用箇所 |
|--------|--------------|---------|
| GitHub ユーザー情報 (avatar_url 等) | API 信頼・React attribute として描画（`validateUrl` 経由への強化は監査 follow-up） | `GithubModal.jsx` |
| pull した本文・ファイル名 | `validatePulledContent()` — バイナリ/巨大/Bidi/不可視文字検証 + `sanitizeFileName()`（#285）。deny は隔離（#291） | `GithubModal.jsx:handleOpenFile`, `AppContext.jsx:switchBranch`, `sync.js:processPull/processConflict` |
| リポジトリ内ファイル本文（preview 描画） | Markdown エスケープ（`markdown.js`）+ XSS テスト | `PreviewMode.jsx` |
| リポジトリ内ファイル名・パス | `validateGitHubWritePath()` — パストラバーサル・禁止パス | `github.js:commitFile` |
| PR URL | GitHub API 信頼・href として描画（`validateUrl` 経由への強化は監査 follow-up） | `GithubModal.jsx` |

### GitHub への書き込み（EXTERNAL → TRUSTED 境界）

| データ | バリデーション | 適用箇所 |
|--------|--------------|---------|
| コミット先パス | `validateGitHubWritePath()` | `github.js` |
| コミット先 rootPath | `validateWorkspaceRootPath()` | `validateWorkspaceSettings.js`（client。normalize/serialize 経路で実効）。worker `PUT /sync/settings` にトップレベル `githubRepoPath` の防御多層 guard あり（#469。ただし後述のとおり現状この経路に githubRepoPath は流れない）。client/worker の受理集合一致は parity テストで担保（`src/lib/security/rootPathValidationParity.test.js`） |
| メタデータ export 値 | `serializeFileMetadataForGit()` — allowlist + サニタイズ | `serializeMetadataForGit.js` |
| sync push 時のファイル名（`PUT /sync/file/:id`） | `sanitizeFileName()`（作成/リネーム時＋`normalizeFileRecords()` 経由の hydrate 時に適用済み。sync push 自体は再サニタイズしない） | `syncFile()`（`src/lib/sync.js`）→ worker `validateFileName()`（`worker/src/validation.ts`。boolean 判定。ASCII 制御文字・`/`・`\`・`.`/`..` のみ拒否、Bidi/不可視文字は非検査。**worker 側は client の事前サニタイズに依存する薄い防御多層** — hydrate を経ずに `syncFile()` を呼ぶ経路が将来追加されると Bidi/不可視文字を含む未サニタイズ名が worker 検証を素通りしうる） |
| repo 認可（`POST /auth/authorize-repo`） | `authorizeRepo(owner, repo)`（`src/lib/github.js`。型・非空チェックのみ、形式検証なし） | `validateOwnerRepo()`（`worker/src/validation.ts`。`OWNER_RE`/`REPO_RE` 形式検証。**client 側は事実上ノーガードで、この worker 検証が唯一の fail-closed 境界** — 通過後 `authorizedRepos`〔KV セッション〕へ保存され `github-proxy.ts` の認可判定に使われる、#283） |

---

## バリデーション関数一覧

| 関数 | ファイル | 用途 |
|------|---------|------|
| `validateUrl(value)` | `src/lib/security/validateUrl.js` | URL スキーム検証（https/http のみ） |
| `sanitizeUrlForExport(value)` | `src/lib/security/validateUrl.js` | export 用 URL サニタイズ（trim + スキーム検証） |
| `validateCommitMessage(template)` | `src/lib/security/validateCommitMessage.js` | コミットメッセージテンプレート検証 |
| `sanitizeFileName(name)` | `src/lib/security/validateSafeFileName.js` | ファイル名サニタイズ |
| `validateGitHubWritePath(path)` | `src/lib/security/validateGitHubWritePath.js` | GitHub 書き込みパス検証 |
| `validateWorkspaceRootPath(path)` | `src/lib/metadata/validateWorkspaceSettings.js` | rootPath / githubRepoPath 検証 |
| `normalizeFileMetadata(raw, opts)` | `src/lib/metadata/normalizeFileMetadata.js` | IDB 読み込み時の正規化・型強制 |
| `normalizeFileRecords(rows)` | `src/lib/normalizeFileRecord.js` | IDB/LS の files レコードの hydrate 時正規化（#282） |
| `validatePulledContent(content, name)` | `src/lib/security/validatePulledContent.js` | pull した EXTERNAL 本文・名前の検証（#285） |
| `sanitizeClipboardEvent(event)` | `src/lib/security/sanitizeClipboard.js` | クリップボード貼り付けの不可視文字検出（#147） |
| `serializeFileMetadataForGit(meta, opts)` | `src/lib/metadata/serializeMetadataForGit.js` | export 時フィールド allowlist |
| `hasDangerousChars(str)` / `detectInvisibleChars(str)` | `src/lib/security/unicodeSafety.js` | Bidi / 不可視文字検出 |
| `validateGitHubWritePath` / `validateBranch` / `validateOwnerRepo` / `validateFileName` / `validateWorkspaceRootPath` | `worker/src/validation.ts` | worker 側（最終防衛線）の write path / branch / owner-repo / file name / rootPath 検証（`github-proxy.ts` / `auth.ts` / `sync.ts` で配線。rootPath は `PUT /sync/settings` にトップレベル `githubRepoPath` の防御多層 guard として配線 #469） |

---

## client↔worker 検証ペア

同一の入力（GitHub 書き込みパス等）を client と worker の両側で検証する箇所は、**関数名が同じでも内部の禁止セグメント判定が異なりうる**（PR #207 でクライアント/worker の禁止セグメント判定が一時的に乖離しサブディレクトリ配置バイパスを生んだ）。受理集合差分を確認する際は、下記ペアの**実装（内部の禁止セグメント一覧・判定ロジック）を両方読んで**突き合わせる — 関数名の一致だけでは不十分（内部シンボル名は #475 で対称化したが、その意味と限界は後述の「内部シンボルの命名対応表」を参照）。

| 検証対象 | client | worker | 備考 |
|---|---|---|---|
| GitHub 書き込みファイルパス | `validateGitHubWritePath()`（`src/lib/security/validateGitHubWritePath.js`。内部で private `hasForbiddenWriteSegment`） | `validateGitHubWritePath()`（`worker/src/validation.ts`。内部で private `hasForbiddenWriteSegment`） | 両者は同名だが別ファイルの別実装。パッケージ管理ファイル（`package.json` 等）はルート直下のみ禁止で意図的に整合させている（PR #207 #108）。内部ヘルパー `hasForbiddenWriteSegment` は両側同名・同判定（#475）。⚠️ この経路は parity テストの共有ベクター検証**対象外**（VECTORS は `validateWorkspaceRootPath` のみを叩く。共有ベクター化は **#504**）。client 側は `tests/security/github-write-path.test.js` が CI（`lint-test` ジョブの `npm run test`）で実行されるが、**worker 側の `worker/src/__tests__/` は CI のどのジョブでも実行されない**（`vite.config.js` が `worker/**` を除外し、`ci.yml` で `working-directory: worker` を使うのは `audit` のみ）。**#506**。ただし全部が無検査ではない — parity テストはルートの vitest で走り worker ソースを直接 import/走査するため、`hasForbiddenWriteSegment` の削除・rename、`BIDI_RE`/`FORBIDDEN_PKG`/`ROOTPATH_FORBIDDEN_CHAR_RE` のドリフト、`validateWorkspaceRootPath` の受理集合変化は CI で検出される。CI を素通りするのは **①共有ベクターに無い入力クラスの write path 意味変更**（本行の共有ベクター化＝**#504** 穴2）と **②worker 固有の配線**（`sync.ts` / `github-proxy.ts` の guard 呼び出しの削除等。parity テストは `validation.ts` しか読まない） |
| GitHub リポジトリルートパス（`githubRepoPath`） | `validateWorkspaceRootPath()`（`src/lib/metadata/validateWorkspaceSettings.js`。内部で `validateGitHubWritePath()`〔書き込みパス用＝機微セグメント〕＋ `hasForbiddenPkgSegment()`〔rootPath 用にパッケージ管理ファイルを全セグメント禁止〕の**合成**。normalize/serialize 経路で実効） | `validateWorkspaceRootPath()`（`worker/src/validation.ts`。内部で private `hasForbiddenRootPathSegment`〔client とは構造が異なる — 後述の命名対応表を参照〕。`PUT /sync/settings` にトップレベル `githubRepoPath` の防御多層 guard として配線） | **受理集合は一致（#469。parity テスト `rootPathValidationParity.test.js`〔#471 柱3〕で担保）**。client 側は rootPath 用途で `a/package.json` 等サブディレクトリ配置のパッケージ管理ファイル名も禁止するよう厳格化し worker と揃えた（書き込みパス用途 `validateGitHubWritePath` はルート直下のみ禁止のまま温存）。⚠️ **重要な限界**: `githubRepoPath` は本来 per-`WorkSettings`（`workSettings` IDB ストア）のフィールドで、**現状 `/sync/settings` にトップレベル値として流れる経路は無い**（`src/` に `/sync/settings` を叩く呼び出し元が1つも無く GET/PUT とも未配線＝将来用。`serializeWorkSettingsForGit` も未使用）。worker guard は将来 WorkSettings がトップレベル `githubRepoPath` 形状で同期される場合の防御多層であり、ネスト形状（`workSettings[].githubRepoPath` 等）で同期される場合はその形状に対する検証を別途要する。**実配線時の検証形状（per-work ネスト）・空値の扱い（フィールド単位 drop・全体 400 にしない）は `github-boundary.md` §9 で設計済み（#474）**。（#469 は「live な検証欠落の修正」ではなく「防御多層＋受理集合 parity＋境界の明示」）。両側の `validateWorkspaceRootPath` が `ROOTPATH_FORBIDDEN_CHAR_RE`（#478 で列挙式から **Unicode カテゴリ deny-list**〔`u` フラグ〕へ移行: `\p{Cc}`制御・`\p{Cf}`format〔ZW*/SHY/BOM/Bidi 等〕・`\p{Cs}`孤立サロゲート・`\p{Co}`私用領域・`\p{Zl}`/`\p{Zp}`行/段落区切り・`\p{Default_Ignorable_Code_Point}`〔VS/U+3164/U+115F 等〕・`\p{Zs}` から U+0020 を除いた空白 homograph〔NBSP/全角スペース/en-quad 系〕を明示列挙）で拒否する。**ASCII スペース U+0020 のみ許容**（設計判断 #478）。`\p{Cs}`/u は孤立サロゲートのみ検出し**単一コードポイントの** astral〔emoji・CJK 拡張B〕は許容するが、**ZWJ/VS/tag で合成した emoji 列**（family 絵文字・キーキャップ・地域旗等）は連結子（ZWJ=`\p{Cf}`・VS=`\p{Default_Ignorable_Code_Point}`）が拒否対象のため列全体が拒否される（連結子自体が spoofing ベクターのため意図的。repo ディレクトリプレフィックスに合成 emoji を使う正当性は低い）。parity テスト（`rootPathValidationParity.test.js`）が client↔worker の source/flags 一致、INVISIBLE_WARN 被覆、`\p{Zs}`（U+0020 除く）被覆、合成 emoji・PUA の拒否、`\p{M}` 結合マークの許容を機械検査する。⚠️ **残る限界（対象外）**: ①`%2e%2e`（percent-encoded `..`。github-proxy 再検証で緩和）②mixed-script homograph（Cyrillic а vs Latin a 等、文字クラスでは判別不能。confusables データが必要）③blank レンダリングだが拒否カテゴリ外の記号（U+2800 BRAILLE BLANK 等の `\p{So}`。個別列挙は whack-a-mole のため追わない）④client/worker が別エンジン（利用者ブラウザ ↔ Cloudflare V8）で動く場合、カテゴリはランタイムの Unicode 版で解決されるため新規割当コードポイントで受理集合が理論上乖離しうる（実務リスクは低いが parity テストは単一 Node 評価のため構造的に非検出） |

### 内部シンボルの命名対応表（#475）

🔴 **名前の一致は突き合わせの出発点であって、等価であることの根拠ではない**。受理集合の等価性を担保するのは parity テストだけで、名前は「どれとどれを見比べるか」を示すにすぎない。

#### 表A: 両側で同名のシンボル（parity 対象の全量）

| 検査対象 | client | worker | 対称性の担保 |
|---|---|---|---|
| 書き込みパスの禁止セグメント判定（pkg はルート直下のみ） | `hasForbiddenWriteSegment`（private。`src/lib/security/validateGitHubWritePath.js`） | `hasForbiddenWriteSegment`（private。`worker/src/validation.ts`） | 同名・同判定。**名前の存在のみ** parity テストのソース走査で機械検査（判定内容は非検査） |
| セグメント正規化（小文字化＋末尾 `.`/空白除去） | `cleanPathSegments`（private。同上） | `cleanPathSegments`（private。同上） | 同上 |
| パッケージ管理ファイル集合 | `FORBIDDEN_PKG`（export。同上） | `FORBIDDEN_PKG`（export。同上） | 同名・同値。parity テストが集合一致を機械検査（両側同名 import のため片側 rename で即失敗） |
| Bidi 制御文字の正規表現 | `BIDI_RE`（export。同上） | `BIDI_RE`（export。同上） | 同上（source **および flags** 一致。加えて状態を持つ `g`/`y` フラグの不使用も固定 — 片側に `g` が付くと `lastIndex` の持ち越しで同じ入力が呼び出しごとに true/false を交互に返し、Bidi 入りパスが断続的に受理される。#475 敵対的レビューが実測） |
| 制御・不可視文字の正規表現 | `ROOTPATH_FORBIDDEN_CHAR_RE`（export。`src/lib/metadata/validateWorkspaceSettings.js`） | `ROOTPATH_FORBIDDEN_CHAR_RE`（export。`worker/src/validation.ts`） | 同上（source/flags 一致） |
| rootPath の検証本体 | `validateWorkspaceRootPath()`（export。`src/lib/metadata/validateWorkspaceSettings.js`） | `validateWorkspaceRootPath()`（export。`worker/src/validation.ts`） | 受理集合は parity テストのベクター表で検査。⚠️ ただし**戻り値契約は非等価**（client `{ ok, reason }` / worker `string \| null`）。client の `.ok` idiom を worker へ移植すると常に `undefined` で fail-open になる（`github-boundary.md` §9.3 に実測付き。#474） |

#### 表B: 意図的に名前を揃えていない箇所（恒久的な設計判断）

構造が異なるため、同名にすると単体等価と誤読される。

| 検査対象 | client | worker | 非対称の理由 |
|---|---|---|---|
| rootPath の禁止セグメント判定 | `validateGitHubWritePath()`〔機微セグメント〕＋ `hasForbiddenPkgSegment()`〔pkg 全セグメント。export〕の**合成**（`src/lib/metadata/validateWorkspaceSettings.js` で合成） | `hasForbiddenRootPathSegment()`〔機微セグメント＋pkg を単独で判定。private。`worker/src/validation.ts`〕 | `hasForbiddenRootPathSegment` は **worker 側にしか存在しない名前**（client を grep して見つからないのが正しい状態。旧名 `hasForbiddenSegment` から #475 で改名）。client は書き込みパス検証を再利用する合成、worker は単独判定。**ヘルパー単体では受理集合が一致しない**（例 `a/.git` は client `hasForbiddenPkgSegment`=false / worker `hasForbiddenRootPathSegment`=true）。呼び出し側の `validateWorkspaceRootPath` で初めて一致する。⚠️ **変更の波及が非対称**: client は合成のため書き込みパス側に機微セグメントを1語足すと rootPath 側にも自動伝播するが、worker は2関数に別々に列挙しているため伝播しない。**書き込みパス側だけを変えたつもりでも rootPath の受理集合が片側だけ動く**ので、機微セグメントを触るときは必ず worker の2関数も更新すること |

#### 表C: #504 で回収する既知の非対称（暫定・設計判断ではない）

| 検査対象 | client | worker | 現状 |
|---|---|---|---|
| `.env` / `.envrc` の禁止語彙 | `FORBIDDEN_ANY_SEGMENT`（private Set。`src/lib/security/validateGitHubWritePath.js`） | `hasForbiddenRootPathSegment` / `hasForbiddenWriteSegment` にインライン literal（`worker/src/validation.ts`） | #475 は命名の対称化までをスコープとし、構造の対称化と集合一致の機械検査は **#504** に切り出した。`FORBIDDEN_PKG` と違って**機械検査に掛からない**ため、片側だけ語彙を足すと無検出で乖離する |

#### 機械検査が届かない範囲

- private ヘルパーのソース走査は**名前の存在のみ**（判定内容が片側で変わっても検出しない）。検査対象は `rootPathValidationParity.test.js` 内のリストで、表Aの private 行と手動同期。走査は TypeScript parser（`ts.createSourceFile`）でトップレベルの**実行時ローカル束縛**を判定するため、コメント・文字列・テンプレートリテラル中の同綴り、alias（`NAME as X`）、`import type`・インライン `type`、`declare` による ambient 宣言では満たせない（共有モジュールへ抽出した場合は import 束縛で満たす）。認める/認めない形の全量は同ファイルの `BINDING_CASES` が機械検査する。
- ベクター表は点検証のため、**表に無い入力クラスの片側ドリフトは無検出**。
- 表B・表Cの行には名前の機械検査が無い。表A・表Bの「対称性の担保」列に書いた内容そのもの（例「同判定である」）も機械検査できない — 表は読み手への案内であって不変条件の執行者ではない。
- **worker 側の単体テストは CI 未実行**（#506）。parity テストはルートの vitest で走るため `validation.ts` の実装は読むが、`worker/src/__tests__/` 固有の検査（`sync.ts` / `github-proxy.ts` の guard 配線が生きているか）は CI に載っていない。
- **docs のみの変更では parity テストが走らない**。`scripts/agent/classify-changes.js` が `code=false` を返すと `lint-test` ジョブごと skip されるため、この節や表A〜Cだけを書き換える PR は機械検査を一度も通らない（表の記述と実装の乖離は人手のレビューでしか止まらない）。

#### parity ペアを変更するときの手順

1. 両側の実装を更新する（表B行1の波及の非対称に注意 — 機微セグメントは worker では2関数に列挙されている）。
2. 触れた入力クラスのベクターを `rootPathValidationParity.test.js` の VECTORS に追加する。
3. 新しい共有シンボルを足したら、**判定内容が両側で同一か**を先に判定してから表を選ぶ（同一なら表A・同名にする / 構造が違うなら表B・名前を分ける）。
4. 表Aに private 行を足したら、`rootPathValidationParity.test.js` のソース走査リストにも同じ名前を足す（手動同期）。
5. **#504 完了時**: 表Cの行を表Aへ移し、上の「書き込みパスの共有ベクター化」注記（`validateGitHubWritePath` 行）と本節の「機械検査が届かない範囲」を実態に合わせて更新する。

各表の client 列・worker 列に記載したファイルを直接読んで突き合わせること。private ヘルパーは非 export のためこのファイル冒頭の「バリデーション関数一覧」には載せない（`hasForbiddenPkgSegment` は export だが、単独で呼ぶ検証関数ではなく `validateWorkspaceRootPath` の構成要素のため同様に載せない）。

---

## リポジトリ内で実行され得るパスと変更分類

CI が実行するもの: `.github/workflows/` の各 job と、そこから呼ぶ `scripts/`（`npm ci` 後の
lint/test/analyze 等）。Claude Code がローカルで実行するもの: `.claude/settings.json` の `hooks`
設定から起動される `scripts/agent/hooks/` 配下のスクリプト。

分類規則の正本は `scripts/agent/classify-changes.js`（`PROSE_INERT_PATTERNS` / `CODE_FORCE_PATTERNS`。
#446）— 本文を複製しない。単一パスの判定は
`CHANGED_FILES=<path> node scripts/agent/classify-changes.js` で確認できる。

**fork からの PR では、分類器・required-gate の実装自体が被検査 ref（fork 側の変更）から
checkout・実行される**ため、CI green は信頼境界の保証ではなく QA ゲートに過ぎない — 信頼境界は
secrets を fork PR の job へ伝播しない設定・read-only token・merge 前の人間レビューが担う。

---

## 攻撃ベクターと現状の対策

| 攻撃 | 対策状況 |
|------|---------|
| XSS（Markdown 経由） | ✅ `markdown.js` で文字レベルエスケープ、`dangerouslySetInnerHTML` は escape 後のみ |
| XSS（カスタムフィールド URL） | ✅ `javascript:` / `data:` 等を `validateUrl` / `sanitizeUrlForExport` で拒否 |
| パストラバーサル（GitHub 書き込みファイルパス） | ✅ client / worker 両側の `validateGitHubWritePath`（worker 側は `github-proxy.ts` で配線済み）。rootPath（`githubRepoPath`）は client/worker の受理集合が一致（#469。parity 担保）＋ worker `PUT /sync/settings` に防御多層 guard。ただし同経路に githubRepoPath が流れるのは将来の WorkSettings 同期実装時（上記「client↔worker 検証ペア」の限界注記参照） |
| IDB 改ざん（DevTools） | ✅ `normalizeFileMetadata` で全フィールドを型強制・フォールバック |
| Bidi 制御文字（ファイル名・パス） | ✅ `unicodeSafety.js` + `validateGitHubWritePath` |
| コミットメッセージ注入（null byte・Bidi） | ✅ `validateCommitMessage` で拒否、フォールバックあり |
| GitHub token 漏洩 | ✅ Worker KV + httpOnly cookie で管理、クライアントに渡さない |
| `.github` / `.env` への誤書き込み | ✅ `validateGitHubWritePath` + worker の禁止パスリスト |
| CSRF（Worker 変更系 API） | ✅ `/github/*`（prefix 一括適用）・`/sync/*`（per-route 適用）・`/auth/authorize-repo` の変更系は CSRF token（`workerFetchWithCSRF` + worker `validateCSRFToken`）で検証（監査 M1。対応の定義は [client-and-github-security-audit.md](client-and-github-security-audit.md) の「M1 対応」を正本とする）。⚠️ `POST /auth/logout`・`POST /auth/refresh` は CSRF/セッション検証なし（`/auth/*` の見直しは保留。F-4）。`/github/*` では CSRF 検証を method allowlist（`isAllowedGitHubRequest`）より前段に適用しているため、許可外メソッド/エンドポイントでも 403 の本文は `csrf token missing` になりうる（endpoint 側の `GitHub endpoint not allowed` は出ない）。配備順序（client→worker）・完了判定・残留状態は [ENVIRONMENT.md](../ENVIRONMENT.md)「client / worker のデプロイ順序」を参照（本文複製しない）。 |
| 認可外 repo へのアクセス | ✅ worker セッションの `authorizedRepos` 照合（#283）。範囲外は GitHub へ送らず 403（fail-closed） |
| バイナリ/巨大/不可視文字入り remote 本文 | ✅ `validatePulledContent`（#285）で pull 前段検証、deny は隔離（#291） |

---

## 後続 issue との分担

| issue | 担当範囲 |
|-------|---------|
| **#147** | クリップボード・貼り付け経由の危険入力（不可視文字の可視化・除去） |
| **#148** | エクスポート時の情報漏洩・危険 HTML・外部参照防御 |
| **#149** | ローカル保存データ・IndexedDB・Service Worker cache の保護方針 → [LOCAL-STORAGE-PROTECTION.md](LOCAL-STORAGE-PROTECTION.md) |
| **#150** | 外部 AI・校正 API へ送信する本文範囲と秘匿情報の制御 |
| **#151** | GitHub 連携時の権限・リポジトリ境界・誤 push 防止 → [github-boundary.md](github-boundary.md) |

---

## 関連ドキュメント

- [docs/security/LOCAL-STORAGE-PROTECTION.md](LOCAL-STORAGE-PROTECTION.md) — ローカル保存データ（IndexedDB / localStorage / cache）の保護方針
- [github-boundary.md](github-boundary.md) — GitHub 連携の権限・リポジトリ境界・誤 push 防止設計（#151）
- [docs/data-model/INVARIANTS.md](../data-model/INVARIANTS.md) — メタデータ操作の不変条件
- [docs/REVIEW_GUIDELINES.md](../REVIEW_GUIDELINES.md) — レビュー時のセキュリティチェックリスト
