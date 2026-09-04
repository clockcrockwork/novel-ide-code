# ファイルメタデータシステム（#171）

#171 で導入したメタデータ基盤の技術リファレンス。

**後続 issue の実装者は必ずこのドキュメントと [INVARIANTS.md](INVARIANTS.md) を読んでから着手すること。**

対象 issue: #98（複数タイトル管理）/ #172（汎用一括取り込み）/ #174（メタデータ一括編集）

---

## IndexedDB ストア一覧（DB v3）

| ストア名 | keyPath | 説明 |
|---------|---------|------|
| `files` | `id` | ファイル本文（既存） |
| `fileMetadata` | `fileId` | ファイルごとのメタデータ（#171 追加） |
| `folderMeta` | `folderId` | フォルダごとのメタデータ（#171 追加） |
| `kindDefinitions` | `id` | kind 辞書（#171 追加） |
| `statusDefinitions` | `id` | status 辞書（#171 追加） |
| `customFieldDefs` | `id` | ユーザー定義カスタムフィールド定義（#171 追加） |
| `workSettings` | `id` | 作品単位の設定（#171 追加） |
| `workspaceSettings` | `key` | workspace 全体の設定（#171 追加） |

---

## 型定義

```typescript
// ファイルメタデータ（本文ファイルとは別トランザクションで管理）
type FileMetadataRecord = {
  fileId: string;           // files ストアの id と対応
  workId: string | null;    // workSettings の id
  title: string;            // 表示タイトル（ファイル名とは独立）
  kindId: number;           // kindDefinitions の id（内部のみ）
  statusId: number;         // statusDefinitions の id（内部のみ）
  tagIds: number[];
  custom: Record<string, unknown>; // customFieldDefs の id → 値
  createdAt: number;
  updatedAt: number;
  isDirty: boolean;
};

// フォルダメタデータ
type FolderMetadataRecord = {
  folderId: string;
  workId: string | null;
  kindId: number | null;
  title: string;
  updatedAt: number;
};

// ファイル種別定義（ユーザー編集可能）
type FileKindDefinition = {
  id: number;
  key: string;              // export/sync 用スラッグ（例: "body", "raw"）
  label: string;            // 表示名
  description?: string;
  order: number;
  color?: string;
  flags: FileRoleFlag[];    // アプリの振る舞いを制御する
  isSystem: boolean;
  archived: boolean;
};

// ステータス定義（ユーザー編集可能）
type FileStatusDefinition = {
  id: number;
  key: string;              // export/sync 用スラッグ（例: "draft", "done"）
  label: string;
  order: number;
  color?: string;
  nextStatusIds: number[];
  isTerminal: boolean;
  archived: boolean;
};

// ユーザー定義カスタムフィールド
type CustomFieldDefinition = {
  id: string;               // stable UUID
  workId: string;
  key: string;              // export 用スラッグ（英数字・アンダースコア・ハイフンのみ）
  label: string;
  type: "text" | "number" | "boolean" | "date" | "url" | "select" | "multi-select";
  options?: string[];       // select / multi-select の選択肢
  defaultValue?: unknown;
  order: number;
  archived: boolean;
};

// 振る舞いフラグ（closed enum — ユーザー定義不可）
type FileRoleFlag =
  | "editable"              // WriteMode で編集可
  | "mainPaneAllowed"       // メインペインで開ける
  | "referencePaneAllowed"  // 参照ペインで開ける
  | "referencePanePreferred"// 参照ペインをデフォルトにする
  | "sidePanePreferred"
  | "exportable"            // エクスポート対象
  | "wordCountTarget"       // 字数カウント対象
  | "searchTarget"          // 全文検索対象
  | "proofreadTarget"       // 校正対象
  | "diffTarget"            // diff 対象
  | "rawLike"               // 未整理扱い（export 対象外デフォルト）
  | "readOnlyDefault"       // デフォルトで読み取り専用
  | "hiddenByDefault";      // デフォルトで非表示

// 作品設定
type WorkSettings = {
  id: string;
  label: string;            // 表示名（上限 200 文字 = serializeWorkSettingsForGit と揃える）
  githubRepoPath?: string;  // GitHub 連携時のリポジトリ内ディレクトリプレフィックス
  configPath?: string;
  createdAt: number;
  updatedAt: number;
};
```

### 作品（WorkSettings）とフォルダの対応（#214）

MVP Alpha の「作品・チャプター管理」は既存の files / folders 構造の上に成立させる：

- **作品** = トップレベル folder + `WorkSettings` レコード。`FolderMeta.workId` で紐付ける
- **チャプター** = 作品 folder 配下の `files` レコード 1 件（新エンティティは作らない）
- **チャプター名の正** = `files.name`（GitHub 同期のファイル名と一致を維持）。`FileMetadata.title` は将来の表示タイトル分離用に温存し、rename では変更しない
- 作成順序は `WorkSettings` → folder → `FolderMeta.workId`（参照先を先に作る）。途中失敗は「workId 未紐付けの folder」または「orphan な WorkSettings」に留まり、いずれも表示フォールバック（作品名不明 / 通常フォルダ扱い）で吸収する
- `workId` が dangling（参照先 WorkSettings が無い）でもクラッシュ・空白表示にしない
- ランタイム正規化は `normalizeWorkSettings`（不正レコードは filter、`githubRepoPath` は `validateWorkspaceRootPath` を通らなければフィールド単位で drop = fail-closed）
- 既存データ互換: `FolderMeta` も `workId` も持たない folder は従来どおり通常フォルダとして表示・編集できる（migration 不要。`workSettings` ストアは DB v3 で定義済み）

---

## デフォルト kind / status

### kind（初期データ）

| id | key | label | 主な flags |
|----|-----|-------|-----------|
| 10 | body | 本文 | editable, exportable, wordCountTarget, proofreadTarget |
| 20 | raw | 未整理 | editable, rawLike（export 対象外） |
| 30 | setting | 設定 | editable, referencePanePreferred |
| 40 | reference | 参照資料 | referencePanePreferred, readOnlyDefault |

### status（初期データ）

| id | key | label | nextStatusIds |
|----|-----|-------|--------------|
| 10 | raw | 未整理 | [20] |
| 20 | draft | 草稿 | [30] |
| 30 | revision | 改稿中 | [40] |
| 40 | done | 完成 | [] (isTerminal) |

---

## CRUD API

### fileMetadataStore（`src/stores/fileMetadataStore.js`）

```javascript
// 読み込み時に全データをハイドレート（AppContext から呼ばれる）
metadataActions.hydrate()

// ファイル作成時：fileMetadata を自動生成
metadataActions.ensureFileMetadata(fileId, { title: fileName })

// メタデータ更新（本文の isDirty に影響しない）
metadataActions.updateFileMetadata(fileId, { kindId, statusId, title, custom })

// ファイル削除時
metadataActions.deleteFileMetadata(fileId)

// フォルダ削除時
metadataActions.deleteFolderMeta(folderId)
```

### flags ベースの判定ユーティリティ

```javascript
import { hasFlag } from 'src/lib/metadata/normalizeFileMetadata';

// kindId の直接比較は禁止 — 必ず hasFlag を使う
const isExportable = hasFlag(meta.kindId, 'exportable', kindDefinitions);
const isProofreadTarget = hasFlag(meta.kindId, 'proofreadTarget', kindDefinitions);
const isWordCountTarget = hasFlag(meta.kindId, 'wordCountTarget', kindDefinitions);
```

---

## セキュリティ設計

### 信頼しない入力

- IndexedDB に保存されたすべての値（DevTools で改ざん可能）
- `WorkSettings.githubRepoPath`（パス traversal のリスク）
- カスタムフィールドの値（XSS のリスク）

### 検証モジュール（`src/lib/metadata/`）

| ファイル | 役割 | 実行タイミング |
|---------|------|--------------|
| `validateWorkspaceSettings.js` | `githubRepoPath` 等の write 時検証 | DB 書き込み前 |
| `normalizeFileMetadata.js` | read 時の正規化・型強制（throw しない） | DB 読み込み直後 |
| `serializeMetadataForGit.js` | export 時 allowlist 適用・URL 検証 | Git push 前 |

### githubRepoPath の制約

- null バイト / バックスラッシュ / `..` / `.` セグメント禁止
- 先頭・末尾 `/` 禁止
- `?` / `#` / `%2F` 禁止（URL 注入防止）
- Bidi 制御文字禁止
- 最大 256 文字

### カスタムフィールドのレンダリング

- text: React text node（`dangerouslySetInnerHTML` 不使用）
- url: `https://` / `http://` のみ許可
- select: `options` に含まれる値のみ表示

---

## kindId/statusId のポータビリティ規約

`kindId` / `statusId`（整数）は IndexedDB 内部のみで使う。

クロスデバイス同期・GitHub export 時は `kindKey` / `statusKey`（string）を使う。  
シリアライズは `src/lib/metadata/serializeMetadataForGit.js` を通すこと。実装状況は `INVARIANTS.md` #7 を参照。

---

## 関連ファイル

- `src/lib/db.js` — IndexedDB スキーマ（DB_VERSION = 3）
- `src/stores/fileMetadataStore.js` — Zustand ストア
- `src/lib/metadata/validateWorkspaceSettings.js`
- `src/lib/metadata/normalizeFileMetadata.js`
- `src/lib/metadata/serializeMetadataForGit.js`
- `src/components/sidebar/FileMetadataMod.jsx`
- `docs/data-model/INVARIANTS.md` — 不変条件（必読）
