# メタデータシステム 不変条件（#171 基盤）

> **このファイルを変更する場合は、関連する全 issue / PR の担当者に通知すること。**
> `#98` / `#172` / `#174` はこのドキュメントに依存する。

---

## 1. kind 判定は flags ベース（直接比較禁止）

```javascript
// ❌ 禁止：kindId や kind.key を直接比較する
if (meta.kindId === 10) { /* 本文として扱う */ }
if (kind.key === 'body') { /* 本文として扱う */ }

// ✅ 正しい：hasFlag を使う
import { hasFlag } from 'src/lib/metadata/normalizeFileMetadata';
if (hasFlag(meta.kindId, 'wordCountTarget', kindDefinitions)) { /* 字数カウント対象 */ }
if (hasFlag(meta.kindId, 'exportable', kindDefinitions)) { /* エクスポート対象 */ }
```

理由: `kindId` の意味はユーザーが追加・変更できるため、数字や名前の意味が変わる可能性がある。

**現状**: `hasFlag` の呼び出しは 0 件、`kindId` を値と直接比較している箇所も 0 件（規則は現状 vacuously satisfied・違反 0 件）。ただし「消費側が無い」わけではない——flag が支配する領域には稼働中の機能があり、`ExportModal.jsx`（現在ファイル単位の export）・`WordCountMod.jsx`（字数カウント）はいずれも flag を参照せずに動いている。未着手なのは **flag 判定を要する消費側**（作品単位 export・校正）である。`hasFlag` が未使用なのは配線漏れではない。**この注記の見直しポイント**: `exportable` / `proofreadTarget` / `wordCountTarget` のいずれかを実際に判定する実装が入るとき（例: `#216` の作品単位 export〔`docs/planning/issue-dependency-map.md`「F. MVP Alpha 本線」〕、`#242` のローカル校正〔Beta 段階。`docs/MVP_PLAN.md`「校正・辞書・外部 API 校正の段階」〕）、**その消費側を実装する PR で本注記を見直す**。

---

## 2. rootPath / githubRepoPath は検証必須

```javascript
import { validateWorkspaceRootPath } from 'src/lib/metadata/validateWorkspaceSettings';

// DB に書き込む前に必ず検証する
const result = validateWorkspaceRootPath(userInputPath);
if (!result.ok) { /* エラーを UI に返す */ return; }

// DB から読み込んだ値も GitHub API で使う前に検証する
const pathCheck = validateWorkspaceRootPath(storedPath);
if (!pathCheck.ok) { console.warn('rootPath が不正です:', pathCheck.reason); return; }
```

禁止される値の例: `../secret`, `/absolute`, `path?query`, `path%2Ftravel`

---

## 3. 本文と metadata は別トランザクション（isDirty は独立）

```javascript
// ✅ 本文更新（metadata の isDirty に影響しない）
dbPut('files', { ...fileRecord, content: newContent, isDirty: true });

// ✅ メタデータ更新（files ストアの isDirty に影響しない）
metadataActions.updateFileMetadata(fileId, { kindId: 30 });

// ❌ 禁止：本文更新の中でメタデータを一緒に書き換える
```

**syncState（IndexedDB v4。#610）も本規則の対象**: 同期状態の同一性（adoptedHash）は
`syncState` ストア（keyPath `id`。`{ id, adoptedHash, adoptedAt }`）に独立して持ち、
`files` / `fileMetadata` の `isDirty` には一切書き込まない（逆方向も同様）。
`docs/data-model/sync-contract.md` の `deriveSyncAction` が読み書きする唯一のストアであり、
本文・metadata の更新経路から直接触れない。
`syncState` は file/folder 単位の `{ id, adoptedHash, adoptedAt }` レコードに加え、structure
base（前回採用した folders/parentId の写し。合成キー `#structure`。`FILE_ID_RE` 不適合文字を
含み実在の file/folder id と衝突しない）を 1 レコード持つ（#394 C-1。`src/lib/sync/structure.js`
の `STRUCTURE_BASE_KEY`）。

---

## 4. 一括編集は部分成功で終わらない（#174 向け）

複数ファイルへの一括 metadata 書き込みは、以下のどちらかでなければならない:
- **全件成功**
- **全件ロールバック**（partial success で終わらない）

Git 連携時は一括変更を 1 コミットにまとめること。

---

## 5. 取り込みセキュリティ規則（#172 向け）

- 取り込み対象は allowlist 拡張子のみ（`.md` / `.markdown` / `.txt` / `.tex`）
- ファイルパスは `validateWorkspaceRootPath` を通すこと
- frontmatter / metadata ブロックを検出しても、自動確定変換しない（候補表示に留める）
- 取り込み前に必ずレビュー UI を挟む（バックグラウンドサイレント取り込み禁止）
- 取り込んだ本文ファイルの `content` を書き換えない

---

## 6. カスタムフィールドの描画規則

- `text` 型: React text node として描画（`dangerouslySetInnerHTML` 禁止）
- `url` 型: `https://` / `http://` のみ許可。それ以外は空文字として扱う
- `select` 型: `options` に含まれる値のみ表示
- 値長上限: 2000 文字

---

## 7. export / Git push のサニタイズ

```javascript
import { serializeFileMetadataForGit } from 'src/lib/metadata/serializeMetadataForGit';

// Git に書き込む前に必ずシリアライズ関数を通す
const payload = serializeFileMetadataForGit(metadata, { kindDefs, statusDefs, fieldDefs });
// → isDirty 等の内部フィールドが除外される
// → kindId/statusId が kindKey/statusKey（string）に変換される
// → URL フィールドのスキームが検証される
```

**現状**: ファイルメタデータを Git / GitHub へ書き出す経路は未実装（`src/lib/sync.js` の payload・manifest ともメタデータを含まない）。この allowlist の対応 issue は `#148`（`docs/planning/issue-dependency-map.md`「E. セキュリティ」、`docs/security/LOCAL-STORAGE-PROTECTION.md`「export 時の漏洩防御の正本は #148」）。本節は実装時に必ず通す規約であり、`serializeFileMetadataForGit` が未使用なのは配線漏れではない。**この注記の見直しポイント**: `serializeFileMetadataForGit` を実際に通す実装が入るとき（`#148`）、**その消費側を実装する PR で本注記を見直す**。

---

## 8. DB バージョン管理規則

- 新しいストア追加は必ず `DB_VERSION` をインクリメントする（`src/lib/db.js`）
- `onupgradeneeded` でのマイグレーションは冪等にする（既存データを破壊しない）
- 旧レコード（`workId` が未設定等）は安全なデフォルトで扱う
- **新ストア追加時は backup / restore 側の更新も必須**（JSON バックアップ復元 #216 / #219）:
  - `src/lib/restore.js` の `recordsByStore`（`restoreFromBackup` 内）に新ストアを追加する
  - `src/lib/db.test.js` のストア集合固定テスト（`getDb() が作成するストア集合の固定`）を更新する
  - 過去 `dbVersion` 用の backup migration を追加する（`src/lib/backup.js` の `checkDbVersion` は
    過去 `dbVersion` を fail-closed で拒否するため、migration が無い限り旧バックアップは復元できない）
  - 上記いずれかを怠ると、リリース後に全ユーザーの復元が失敗する（原因追跡が困難になる）

---

## 9. IndexedDB 改ざん耐性

DB から読み込んだ値は必ず正規化してから使う。DevTools による改ざんを前提とする。

```javascript
import { normalizeFileMetadata } from 'src/lib/metadata/normalizeFileMetadata';

const rawFromIDB = await dbGet('fileMetadata', fileId);
const safe = normalizeFileMetadata(rawFromIDB, { kindIdSet, statusIdSet });
// → kindId/statusId が存在しない定義を参照していたら安全なデフォルトに差し替え
// → throw しない
```

---

## 10. 信頼境界（#145 基盤）

ユーザー入力・外部データを扱う際は `docs/security/TRUST-BOUNDARY.md` を参照し、適切なバリデーション関数を使うこと。

主要ルール:

- **URL フィールド**: `validateUrl()` / `sanitizeUrlForExport()` を使用。`javascript:` / `data:` 等は拒否
- **コミットメッセージテンプレート**: `validateCommitMessage()` を通し、違反時はデフォルト文字列にフォールバック
- **ファイル名・フォルダ名**: `sanitizeFileName()` を使用
- **GitHub 書き込みパス**: `validateGitHubWritePath()` を使用。worker 側でも再検証必須
- **IDB から読み込んだ値**: `normalizeFileMetadata()` で型強制してから使用（throw しない）
- **カスタムフィールド export**: `serializeFileMetadataForGit()` の allowlist を通す

後続 issue (#147〜#151) が新たな入力源を追加する際は、このドキュメントのマッピング表を更新すること。

---

## 11. プロトタイプ汚染防止（必須）

IDB / ユーザー入力由来の動的キーを持つオブジェクトは `Object.create(null)` で初期化すること。

```javascript
// ❌ 禁止: __proto__ キーで Object のプロトタイプチェーンが汚染される
const result = {};
result[fieldId] = value;          // fieldId = '__proto__' で汚染

// ✅ 正しい
const result = Object.create(null);
result[fieldId] = value;

// Object.fromEntries() は Object.assign(Object.create(null), ...) でラップ
// ❌ 禁止
const defsById = Object.fromEntries(entries);
// ✅ 正しい
const defsById = Object.assign(Object.create(null), Object.fromEntries(entries));

// 既存オブジェクトへのブラケット代入前は Object.hasOwn で所有チェック
if (!Object.hasOwn(fileMetadataMap, fileId)) return;
fileMetadataMap[fileId] = normalized;
```

lint ルール: `local/no-plain-object-dict` / `security/detect-object-injection`  
根拠: PR#207 で 5 コミットにわたり同パターンが修正された（#86, #106, #107, #111, #112）

---

## 12. パスバリデーションはセグメント単位（必須）

ファイルパスの禁止文字列チェックはセグメント単位（`split('/').some()`）で行うこと。

```javascript
const FORBIDDEN = new Set(['.github', '.env', '.envrc']);

// ❌ 禁止: startsWith() は subfolder/.github をバイパスする
if (path.startsWith('.github')) return false;

// ✅ 正しい
if (path.split('/').some(seg => FORBIDDEN.has(seg))) return false;
```

lint ルール: `local/no-path-startswith-segment`  
根拠: PR#207 で 4 ラウンドにわたり同パターンが指摘された（#50, #72, #89, #108）

---

## 13. 入力・IDB 値の型強制規則（必須）

ユーザー入力・IDB から読み込んだ値を数値・論理値に変換する際は、型を明示的に確認すること。

```javascript
// ❌ 禁止: Number('') = 0 のため未入力が 0 として送信される
onChange(Number(e.target.value));

// ✅ 正しい
onChange(e.target.value === '' ? undefined : Number(e.target.value));

// ❌ 禁止: Boolean("false") = true のため IDB 文字列値が true に coerce される
return Boolean(rawValue);

// ✅ 正しい
return typeof rawValue === 'boolean' ? rawValue : false;

// ❌ 禁止: Number.isFinite(1.5) = true のため整数 ID に小数が通過する
.filter(id => typeof id === 'number' && Number.isFinite(id))

// ✅ 正しい（整数 ID の検証）
.filter(id => typeof id === 'number' && Number.isInteger(id))

// ❌ 禁止: || は 0 / false を falsy として扱う（タイムスタンプ 0 が now に置換される）
const ts = raw.createdAt || Date.now();

// ✅ 正しい
const ts = raw.createdAt ?? Date.now();
```

lint ルール: `local/no-number-coerce-input-value` / `local/no-boolean-coerce-in-normalize` / `local/no-number-is-finite-for-id`  
**注意**: `||` vs `??` パターン（上記最後の例）は lint 未強制。コードレビューで手動確認すること。  
根拠: PR#207 で number coercion が 3 ファイル（#1, #2, #36）、boolean が 2 ラウンド（#59, #92）、isInteger が 4 件（#29, #30, #104, #105）に発生

---

## 14. ローカル保存データの分類と secret 保存先制約（必須）

ブラウザ上の保存領域（IndexedDB / localStorage / sessionStorage / Cache Storage）は信頼境界ではない。DevTools 改変・XSS 読み取りを前提に、以下を守る。

- **secret / credential（token・apiKey・webhook・session 等）を localStorage / sessionStorage / Service Worker cache に保存しない。** localStorage に書き込むキーは [src/stores/persistKeys.js](../../src/stores/persistKeys.js) の `LOCAL_STORAGE_KEYS` に集約し、secret 系の語を含むキーがないことをテストで担保する。
- **IndexedDB から読み込んだ値は利用前に正規化・再検証する**（#9 と同方針）。
- **本文・secret を Service Worker cache に置かない**（SW 導入時）。

```javascript
// ❌ 禁止: secret を localStorage に保存
localStorage.setItem('ide_github_token', token);

// ✅ 正しい: secret はサーバー（Worker KV + HttpOnly Cookie）に隔離し、
//            ブラウザには opaque session token のみを渡す
```

テスト: [tests/security/local-storage-policy.test.js](../../tests/security/local-storage-policy.test.js)（`LOCAL_STORAGE_KEYS` の secret 語チェック / IDB 値の再検証 / プロトタイプ汚染）  
詳細方針: [docs/security/LOCAL-STORAGE-PROTECTION.md](../security/LOCAL-STORAGE-PROTECTION.md)  
根拠: #149（ローカル保存データ・IndexedDB・Service Worker cache の保護方針整理）

---

## 15. workSettings は folderMeta.workId から参照されなくなった時点で削除する（#390）

`workSettings` レコードは、それを参照する `folderMeta.workId` が 1 件も残らなくなった時点で削除する（`deleteFolder` が `deleteAll` / `moveToParent` いずれの strategy でも担う）。他の folder からまだ参照されている `workId` は消してはならない（参照カウントで判断する）。

根拠: #214 で作品 = folder + `workSettings` を導入した際、`deleteFolder` が `workSettings` を関知せず orphan レコードが IDB に残る不整合が発生した（#390）。

本規則は `deleteFolder` が新たに orphan を作らないことを保証するものであり、本規則導入前に IDB へ残った orphan は遡及して掃除しない（実害はフォールバック表示で吸収する）。`fileMetadata.workId` と `customFieldDefs[].workId` は現時点で書き込み経路が無いため参照元として数えない（意図的）。将来これらを消費する実装が入るときは本項目を見直す。

本規則は pull 由来の folder 削除にも及ぶ（#394 C-1）。`src/context/AppContext.jsx` の `applyStructureFromSync`（同期の structure 適用経路）は、remote 側で削除された folder をローカルへ反映する際も `deleteFolder` と同じ参照カウント判定（`collectOrphanedWorkIds`）で orphan `workSettings` を掃除する。
