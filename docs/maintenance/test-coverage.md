# テストカバレッジ可視化

親 Issue: #128 / #255。方針: `docs/maintenance/code-cleanup.md`「1. 清掃対象範囲」。

清掃・リファクタリング（`/code-cleanup`「8. テストを追加 / 更新する」）の対象選定を支援するため、テスト不足箇所を可視化する。**可視化のみ**。テストの一括追加・しきい値での CI fail 化は行わない。

## 使い方

```bash
npm run test:coverage   # vitest run --coverage
```

- コンソールに `text` 要約、`coverage/index.html` に詳細レポート（`coverage/` は git 管理外）
- しきい値未設定のため **exit 0・非 fail**。`npm run check` には組み込まない
- 設定は `vite.config.js` の `test.coverage`（`provider: 'v8'` / `include: ['src/**']`）

## 計測範囲の制約（二重ランナー）

このプロジェクトはテストランナーが3系統に分かれており、**カバレッジ計測は vitest 実行分のみ**を反映する。

| ランナー | 対象 | カバレッジ計測 |
|---------|------|--------------|
| vitest（`test:vitest`） | `src/**/*.test.{js,jsx}` + `src/__tests__/` | ✅ 計測される |
| node --test（`test:node`） | `tests/**/*.test.js` | ❌ **計測されない** |
| Playwright（`test:e2e`） | `e2e/**` | ❌ 計測されない |

**重要**: vitest coverage で 0% と表示されても「未テスト」とは限らない。`tests/**`（node --test）でテスト済みのモジュールは coverage 上 0% に見える。優先リスト作成時は必ず `tests/**` / `e2e/**` とクロスチェックすること。

### node --test でテスト済み（vitest coverage では 0% 表示）

以下は `tests/**` でカバーされており、**未テストではない**：

- `src/lib/annotations.js`（`tests/annotations.test.js`）
- `src/lib/diffCore.js`（`tests/diffCore.test.js`）
- `src/lib/markdown.js`（`tests/markdown.test.js` ほか）
- `src/lib/previewAnnotations.js`（`tests/previewAnnotations.test.js`）
- `src/lib/writingRules.js`（`tests/writingRules.test.js`）
- `src/lib/tiptap/plainTextLoader.js`（`tests/plainTextLoader.test.js`）
- `src/lib/security/unicodeSafety.js`（`tests/security/unicode-safety.test.js`）
- `src/lib/security/validateCommitMessage.js`（`tests/security/validate-commit-message.test.js`）
- `src/lib/security/validateGitHubWritePath.js`（`tests/security/github-write-path.test.js`）
- `src/lib/security/validateSafeFileName.js`（`tests/security/file-name.test.js`）
- `src/lib/security/validateUrl.js`（`tests/security/validate-url.test.js`）

## ベースライン（計測日: 2026-06-14）

`npm run test:coverage` 全体サマリ（vitest 範囲のみ）:

| 指標 | カバレッジ |
|------|-----------|
| Statements | 6.1% (348/5696) |
| Branches | 5.17% (196/3785) |
| Functions | 4.8% (70/1458) |
| Lines | 6.46% (298/4607) |

> 全体値が低いのは、`src/components/**`（E2E でカバー）と node --test 済みモジュールが vitest 範囲外で 0% 計上されるため。数値そのものより**下記の優先リスト**を清掃の指標とする。

## 優先未テストリスト（いずれのランナーでも未テスト）

上記クロスチェックを除外した、**真に未テスト**のドメインロジック・セキュリティ境界。`/code-cleanup` で提供結果単位（対象領域ごとに自己完結する範囲）のテスト追加 PR として着手する。

### 高優先（セキュリティ境界・メタデータ・システム境界）

- `src/lib/security/sanitizeClipboard.js` — クリップボードサニタイズ（security 6 件中、唯一どのランナーでも未テスト）
- `src/lib/metadata/normalizeFileMetadata.js` — IDB 境界の正規化（`docs/data-model/INVARIANTS.md`）
- `src/lib/metadata/serializeMetadataForGit.js` — Git 可読シリアライズ
- `src/lib/metadata/validateWorkspaceSettings.js` — `githubRepoPath` システム境界（`validateWorkspaceRootPath`）

### 中優先（ドメインロジック）

- `src/lib/db.js` — IndexedDB 永続化の主体（0%・233 行）
- `src/lib/github.js` — GitHub API ラッパー（0%）
- `src/lib/workerClient.js` / `src/lib/diffWorkerClient.js` — Worker フェッチ/ロード（0%）
- `src/lib/fileTree.js` — ファイルツリー構築（0%）
- `src/lib/rubyUtils.js` — ルビ変換ユーティリティ（0%）
- `src/lib/lsCache.js` — localStorage debounce キャッシュ（部分 24%）

### 低優先（別ランナーでカバー / UI）

- `src/components/**` — Playwright E2E（`e2e/**`）でカバー
- `src/lib/tiptap/**`（`plainTextLoader.js` 除く）— ProseMirror 拡張。単体より E2E が適する
- `src/stores/**` — Zustand ストア。状態ロジックは単体追加余地あり（中長期）

## 関連

- `docs/maintenance/code-cleanup.md`「1. 清掃対象範囲」「5. PR 単位」
- `docs/agent-workflows/code-cleanup.md`「8. テストを追加 / 更新する」
- `docs/REVIEW_GUIDELINES.md`「テスト」（revert で fail するか・偽陽性回避）
