# 永続化・クロスデバイス同期戦略

## 課題

IndexedDB のみへの保存はクロスデバイス対応として不十分。
校正結果をデバイス間で共有するには別の同期手段が必要。

## 校正結果の保存先

```
                           ┌─────────────────────┐
                           │  Cloudflare KV       │ ← クロスデバイス同期の主体
                           │  PROOFREAD_RESULTS   │   キー: proofread:{login}:{fileId}
                           │  （TTL: 30日）        │   自動有効期限、ストレージコスト低
                           └─────────────────────┘
                                    ↑↓ /api/proofread/* (requireSession)
┌───────────────────────────────────────────────────┐
│ ブラウザ                                           │
│  IndexedDB: proofread_results                     │ ← オフラインキャッシュ・即時表示
│  （KV と同一構造。起動時に KV と差分同期）         │
└───────────────────────────────────────────────────┘
```

### Cloudflare KV スキーマ

```
キー: proofread:{login}:{fileId}
値: JSON（ProofreadRecord）
TTL: 30日（自動削除）
```

既存の `SESSIONS: KVNamespace` と同じ Worker を使用し、
`PROOFREAD_RESULTS: KVNamespace` を追加する（`worker/src/types.ts` を更新）。

### Worker ルート（`worker/src/proofread.ts`）

```ts
// GET  /api/proofread/:fileId     → KV から結果取得
// PUT  /api/proofread/:fileId     → KV に結果保存（ブラウザから push）
// DELETE /api/proofread/:fileId   → KV から削除（「結果をクリア」）
```

### 同期タイミング

- **保存**: 校正実行完了後、IndexedDB に書き込んだのち KV に push
- **取得**: アプリ起動時 or ファイルを開いたとき、KV から pull してキャッシュ更新
- **オフライン時**: IndexedDB のみ使用。オンライン復帰後に KV へ push

---

## ユーザー定義ルールの保存先

詳細は [RULES.md](RULES.md) 参照。

```
優先度（高）→ GitHub リポジトリ（.novel-rules/proofread-rules.json）
優先度（低）→ IndexedDB（オフラインキャッシュ）
```

---

## GitHub Issues との関係

校正結果を個別の GitHub Issues に起こすことは**推奨しない**：

| 問題 | 理由 |
|------|------|
| ノイズ | 1ファイルで数十〜数百件の issues が発生する |
| 追跡困難 | テキスト修正後の自動 close が実装困難 |
| 粒度の不一致 | issues は TODO 管理に向いており、校正結果に適さない |

### 代替案：エクスポート機能として残す

- **GitHub Gist へのスナップショット出力**：ファイル単位の校正サマリーを Gist として保存
  - ファイル名: `proofread-{filename}-{YYYYMMDD}.md`
  - 内容: 件数集計 + 重大度別リスト（markdown）
  - 用途: 他者への共有・アーカイブ・プルリクエストへの添付
- **GitHub Issue への一括出力**（ファイル単位のサマリーのみ）
  - 「章末校正チェック」的な 1 件の issue にまとめる
  - issue body に severity 別件数・主要な指摘事項を記載
  - 修正完了時にユーザーが手動 close（自動化はしない）

---

## IndexedDB スキーマ変更

`src/lib/db.js` の `onupgradeneeded` に追加するストア：

| ストア名 | キー | インデックス | 説明 |
|---------|------|------------|------|
| `proofread_results` | `fileId` | `runAt` | 校正結果キャッシュ |
| `proofread_rules` | `id` | `enabled`, `updatedAt` | ユーザー定義ルール |

---

## API キーの保存先

| キー | 保管場所 | 補足 |
|------|---------|------|
| Yahoo Client ID | Cloudflare KV（`USER_SETTINGS`）推奨・IndexedDB も許容 | Worker KV に `apikey:{login}:yahoo` として保存（IndexedDB 直接呼び出しも可） |
| Gemini API Key | Cloudflare KV（`USER_SETTINGS`） | Worker KV に `apikey:{login}:gemini` として保存 |
| カスタムプロバイダーキー | Cloudflare KV（`USER_SETTINGS`） | Worker KV に `custom_providers:{login}` として保存（設定オブジェクト全体を JSON で） |
| Gemini プロンプト | Cloudflare KV（`USER_SETTINGS`） | `prompt:{login}:gemini` |
| 設定フラグ（自動実行 on/off 等） | IndexedDB `settings` | デバイスローカルで問題ない設定 |

ブラウザ側（IndexedDB）には「登録済み」フラグのみ保存し、実際のキーは Worker KV のみに置く。

---

## textlint 設定の保存

- 有効なルールセット・パラメータ: `.novel-rules/textlint-config.json`（Git リポジトリ管理）
- フォールバック: IndexedDB `settings` の `textlint_config` キー（Git 未連携時）
