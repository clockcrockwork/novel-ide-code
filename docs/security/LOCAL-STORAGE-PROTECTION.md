# ローカル保存データ保護方針

novel-ide がブラウザ上に保存するデータ（IndexedDB / localStorage / sessionStorage / Cache Storage）の分類・保存場所ルール・暗号化/redaction 方針・削除/リセット方針を定める。

[docs/security/TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) の続編であり、後続 issue 分担表の **#149** に対応する。

> **前提**: ブラウザ上の保存領域（IndexedDB / localStorage を含む）は信頼境界ではない。DevTools から改変・読み取りが可能であり、XSS が発生すれば JavaScript からアクセス可能なすべての領域が漏洩・改ざん対象になる。本方針はそれを前提に「何をどこに置くか」「読み出し時にどう再検証するか」を規定する。

---

## 1. データ分類

| 分類 | 例 | 現在の保存先 | 保護要件 |
|------|----|------------|---------|
| **本文・作品データ** | 原稿本文、ファイルツリー、フォルダ、メモ、タグ、手動校正 annotation、進捗 | IndexedDB（`files` / `annotations` / `folders` / `meta`）。後方互換で `ide_files` が localStorage にも残る | 読み出し時に正規化・型検証。XSS で読み取られる前提で、export/Git push に意図しないデータを混ぜない |
| **設定データ** | 表示設定、editor 設定、footer 設定、色設定、word count モード | localStorage（`ide_*` キー）+ IndexedDB `settings` | secret を含めない。型強制規則（INVARIANTS #13）で再検証 |
| **secret / credential 系** | GitHub OAuth token、client secret、CSRF token、（将来）Notion secret・Discord webhook・外部 AI endpoint credential | **ブラウザに保存しない**。Cloudflare Worker の KV + 環境変数に隔離し、ブラウザには opaque session token を HttpOnly Cookie で渡す | localStorage / sessionStorage / IndexedDB / Cache Storage に置かない。やむを得ず置く場合は §3 の暗号化前提 |
| **cache 系** | Service Worker cache、Cache Storage、fetch cache、preview/export 一時データ、PDF 印刷用一時 HTML | 現状未実装（SW / PWA なし）。一時データはメモリ上のみ | 本文・secret を cache しない。導入時は versioning と purge 方針必須（§2） |

---

## 2. 保存場所ごとのルール

### IndexedDB（[src/lib/db.js](../../src/lib/db.js)）

- 本文・設定・メタデータの主保存先（DB v3）。本文系（`files` / `annotations` / `folders`）・設定系（`settings` / `meta` / `workSettings` / `workspaceSettings`）・メタデータ系（`fileMetadata` / `folderMeta` / `kindDefinitions` / `statusDefinitions` / `customFieldDefs`）の各ストアを持つ。
- **secret を保存しない。** やむを得ず保存する場合は §3 の暗号化・表示抑制・redact を前提とする。
- **DevTools 改ざん想定**: 読み出した値は利用前に必ず正規化・再検証する。`files` は [normalizeFileRecords()](../../src/lib/normalizeFileRecord.js)（#282）、`fileMetadata` は [normalizeFileMetadata()](../../src/lib/metadata/normalizeFileMetadata.js)（INVARIANTS #9）、`annotations` は [normalizeAnnotations()](../../src/lib/annotations.js)（`useAnnotations.js` の読み出し直後）を通す。`folders` レコードへの正規化拡大は監査 follow-up。
- 動的キーを持つオブジェクトは `Object.create(null)` で初期化（プロトタイプ汚染対策、INVARIANTS #11）。

### localStorage（[src/stores/persistKeys.js](../../src/stores/persistKeys.js) が書き込みキーの単一情報源）

- **secret 保存禁止。** 書き込むキーは `persistKeys.js` の `LOCAL_STORAGE_KEYS` に集約し、secret 系の語を含むキーがないことを [tests/security/local-storage-policy.test.js](../../tests/security/local-storage-policy.test.js) で機械的に検証する。
- 一時的な UI 状態・軽微な設定に限定する（theme / sidebar / 色 / 選択ファイル ID 等）。
- XSS 時に読み取られる前提で扱う。
- **注記**: `ide_gh_user`（`ghUser`: login / avatar_url）は GitHub から取得した非 secret の表示用情報だが平文で保存される。プライバシー観点では IndexedDB への移行が将来の見直し候補（token 等の credential は含まない）。

### sessionStorage

- 一時状態のみ。現状の唯一の用途は VirtualList のスクロール位置（[src/components/common/VirtualList.jsx](../../src/components/common/VirtualList.jsx)）。
- secret 保存禁止。タブを閉じれば消える前提。

### Service Worker cache / Cache Storage

- **現状未実装。** 導入する場合は以下を満たすこと:
  - 本文・secret を cache しない。
  - API レスポンスを cache する場合、secret や個人情報が含まれないか確認する。
  - cache に versioning（キャッシュ名にバージョン付与）を持ち、更新時に旧 cache を purge する。
  - SW 導入時は本方針に沿った cache 内容テストを追加する（本 PR ではテスト化しない）。

---

## 3. 暗号化・redaction 方針

現時点でブラウザに secret は保存していない（§1）。将来クライアント保存が必要になった場合の方針を定める。**実装は後続 issue。**

- **WebCrypto によるローカル暗号化の位置づけ**: XSS 対策としては不完全（XSS が起きれば復号後の値も盗まれうる）。ただし端末共有・バックアップ流出・DevTools 誤操作・平文保存リスクの低減には有効。
- **鍵の保存場所**: 暗号鍵を保存データと同じ領域に平文で置かない。passphrase 由来鍵 / device key / session key の使い分けを別途設計する。
- **mask**: secret を画面表示する際はマスク（`••••`）し、コピー時のみ復号する。
- **redact**: console / error / toast / log に secret を出さない。エラーオブジェクトに secret を載せない。
- **export / Git push**: secret 相当を混ぜない。メタデータ export は allowlist（[serializeFileMetadataForGit()](../../src/lib/metadata/serializeMetadataForGit.js)）を通す。export 時の漏洩防御の正本は **#148**。

---

## 4. データ削除・リセット導線

実装済み: GitHub 連携解除（`disconnectGithub`、[src/context/AppContext.jsx](../../src/context/AppContext.jsx)）と
ローカルデータ全削除（#279: [src/lib/clearLocalData.js](../../src/lib/clearLocalData.js) `clearAllLocalData()` +
UI [src/components/modals/ClearDataModal.jsx](../../src/components/modals/ClearDataModal.jsx)）。残りは後続 issue で実装する。

| 操作 | 内容 | 現状 |
|------|------|------|
| ローカルデータ全削除 | IndexedDB 全ストア + localStorage の `ide_*` キーを削除しリロード | **実装済み（#279）** |
| secret のみ削除 | credential 系のみ削除（クライアント保存導入後に必要） | 該当データなし |
| cache のみ削除 | Cache Storage / SW cache のクリア | SW 未実装 |
| Service Worker unregister | SW の登録解除 + cache clear | SW 未実装 |
| 連携解除時の関連データ削除 | GitHub / Notion / Discord 連携解除時に関連ローカルデータを削除 | GitHub の session 解除のみ（本文は local-first 設計として意図的に残置。必要なら上記全削除 UI を使う）。Notion/Discord 連携自体が未実装 |
| ログアウト時の残置選択 | 何を残し何を消すかをユーザーが選べる | 未実装 |

---

## 5. 後続 issue への切り出し

本 PR は方針ドキュメントと検証テストに限定する。以下は別 issue として実装する:

- データ削除・リセット導線の UI 実装（§4）— **全削除は #279 で実装済み**。残り（secret のみ削除・ログアウト時の残置選択等）は §4 の表を参照。
- WebCrypto によるローカル暗号化・鍵管理（§3）。
- Service Worker / PWA / Cache Storage 導入時の cache 保護方針の実装とテスト（§2）。
- 読み出し時正規化の拡大（§2）— **files は #282（`normalizeFileRecords`）、annotations は `normalizeAnnotations`（`useAnnotations.js`）で実装済み**。`folders` レコードへの拡大が残（監査 follow-up）。

---

## 関連ドキュメント

- [docs/security/TRUST-BOUNDARY.md](TRUST-BOUNDARY.md) — 信頼境界の定義・入力源別バリデーション
- [docs/data-model/INVARIANTS.md](../data-model/INVARIANTS.md) — 不変条件（#9 IDB 改ざん耐性 / #11 プロトタイプ汚染 / #13 型強制 / #14 ローカル保存データ分類）
- [docs/data-model/file-metadata.md](../data-model/file-metadata.md) — メタデータスキーマと CRUD API
