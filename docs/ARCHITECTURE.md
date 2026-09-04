# アーキテクチャリファレンス

このファイルはプロジェクトの実装詳細を集約した共通リファレンスです。
`CLAUDE.md` / `AGENTS.md` / `GEMINI.md` / `.github/copilot-instructions.md` から参照されます。

---

## 創作文書管理方針

novel-ide は「データを囲い込むアプリ」ではなく、**Git管理された創作文書リポジトリのIDE**として機能する。この方針はファイル保存形式・UI設計・AIワークフロー・校正/レビュー・ドキュメントモードすべてに影響する基本原則である（[#176](https://github.com/clockcrockwork/novel-ide/issues/176)）。

### 1. novel-ide は唯一の読取手段にならない

本文・設計カード・スタイルリファレンス・ワークフロー定義などは、可能な限りリポジトリ上の可読ファイルとして保存する。novel-ide で開くと高度なIDE表示ができるが、novel-ide がなくても VSCode・GitHub・Obsidian 等から最低限読める・編集できる状態を維持する。

### 2. 本文・資料・設計カードは人間可読を優先する

原則として以下の形式を優先する。

- Markdown / MDX 相当
- JSON / YAML 等の軽量メタデータ
- 通常のテキストファイル

独自バイナリ形式や novel-ide 専用DBにしか存在しない形式は避ける。

### 3. IDE固有情報は本文と分離する

本文ファイルに過剰な独自タグを埋め込まず、必要なメタデータは別ファイルまたは Frontmatter 等で扱う。

```
manuscripts/E08.md          ← 本文（人間可読 Markdown）
manuscripts/E08.meta.json   ← エピソードメタ情報
docs/design-cards/E08.md    ← 設計カード（Markdown）
docs/style-reference.md     ← スタイルリファレンス
docs/writing-workflow.md    ← ワークフロー定義
```

novel-ide 固有の表示状態・ペイン状態・レビューUI状態が壊れても、本文と主要資料は読めること。

### 4. ドキュメントモードは設計カードを包括する

設計カード専用の固定フォームではなく、ドキュメントモード上の Markdown/Tiptap 文書として扱う。設計カードは「表示プリセット」または「抽出対象」として機能する（メタ情報テーブル・前提事実・禁止事項・シーン定義・ビート表・チェックリスト等）。フォーマットは AIワークフロー改善に合わせて変更できるよう完全固定しない。

### 5. Git/Diff/PRレビューを創作レビューに転用する

校正・自動整形・AIレビュー・チェックリスト差分は、PRレビューコメントのように扱える設計を目指す。対象：誤字脱字・表記揺れ・文体違反・禁止事項違反・チェックリスト未達・設計カードとの差分・スタイルリファレンス候補。AIを使わない場合でも、校正・手動レビューとして成立すること。

### 6. 原稿単位の作業ブランチ/レビュー運用を検討する

同一原稿ファイルは同一作業ブランチまたは同一レビュー単位で扱う運用を検討する（例：`work/episode-E08` 配下に Phase1〜Phase4）。UI上では Git 用語を過度に出さず、「作業中 / レビュー中 / 未解決コメントあり / mainとの差分あり / マージ待ち」等として抽象化してもよい。

将来設計の詳細は [features/review-workflow.md](features/review-workflow.md) を参照。

---

## State management

状態管理は **移行中**。

- **`src/stores/uiStore.js`**（Zustand + persist）— UI 設定の正となる唯一のストア。`theme`, `sidebarSide`, `showLineNumbers`, `colors`, `splitSwapped` を永続化。エフェメラルな UI フラグ（モーダル表示、モード、セレクション）もここで管理。**必ずセレクターで購読すること**（`useUIStore(s => s.theme)`）。全ストア購読は再レンダリングを増大させる。
- **`src/context/AppContext.jsx`**— ファイル・フォルダ・設定の状態管理。段階的に Zustand stores へ移行中。新しい状態は `src/stores/` に追加する。
- **`src/hooks/useLs.js`**— 旧来の localStorage ラッパー。新規コードでは使わない（IndexedDB or Zustand を使う）。

## Persistence

- **`src/lib/db.js`**（IndexedDB）— ファイル本文・フォルダ・設定・アノテーションの永続化の主体。DB_VERSION = 3。ストア: `files`, `annotations`, `settings`, `meta`, `folders`（既存）+ `fileMetadata`, `folderMeta`, `kindDefinitions`, `statusDefinitions`, `customFieldDefs`, `workSettings`, `workspaceSettings`（#171 追加）。
- **`src/lib/lsCache.js`**— localStorage 書き込みを debounce する薄いキャッシュ。Zustand persist ミドルウェア経由で使用。
- **`src/stores/lsStorage.js`**— Zustand persist 用のマルチキーストレージアダプター。旧来の個別 localStorage キーとの後方互換を維持しながら Zustand に統合する。

## Editor

`src/components/editor/EditorBox.jsx` がモードルーター。4 つのモード：

- `write` — TipTap 3.x / ProseMirror ベースのリッチエディタ（`src/components/editor/WriteMode.jsx`）。カスタム拡張は `src/lib/tiptap/` 以下。
- `preview` — Markdown レンダリング + アノテーションオーバーレイ（`src/components/editor/PreviewMode.jsx`）。
- `diff` — 保存済みスナップショットとの Myers diff 比較（`src/components/editor/DiffMode.jsx`）。
- `structure` — ドラッグ＆ドロップで段落を並べ替え（`src/components/editor/StructureMode.jsx`）。

## File metadata system（#171）

ファイル種別・執筆ステータスをユーザー定義辞書＋flags で管理する基盤。
`#98`（複数タイトル管理）/ `#172`（一括取り込み）/ `#174`（一括メタデータ編集）の依存元。

### 設計原則

- **本文と metadata は完全分離**。`files` ストアと `fileMetadata` ストアは別トランザクションで書き込む。`isDirty` は独立している。
- **kind 判定は flags ベース**。`kindId` の直接比較は行わない。`hasFlag(kindId, flag, kindDefinitions)` 経由で判定する（`src/lib/metadata/normalizeFileMetadata.js`）。
- **未設定ファイルは rawLike**。`fileMetadata` が存在しないファイルは `kindId=20`（未整理）にフォールバックし、**export・proofread の対象外とする**（実装状況は `docs/data-model/INVARIANTS.md` #1 を参照）。
- **rootPath は検証必須**。`WorkSettings.githubRepoPath` は `validateWorkspaceRootPath` を通すこと（`src/lib/metadata/validateWorkspaceSettings.js`）。

詳細スキーマ・API: `docs/data-model/file-metadata.md`  
セキュリティ不変条件: `docs/data-model/INVARIANTS.md`

## Markdown & Diff

- `src/lib/markdown.js` — Markdown → HTML パーサー（PreviewMode で使用）。
- `src/lib/diffCore.js` — Myers diff アルゴリズム（最大 5000 編集 / 64ms タイムアウト、超過時は粗い diff にフォールバック）。
- `src/workers/diffWorker.js` — diff 計算を Web Worker で実行（メインスレッドをブロックしない）。クライアントは `src/lib/diffWorkerClient.js`。
- TipTap カスタム拡張は `src/lib/tiptap/`（AnnotationExtension, InlineCommentMark, RubyMark, SlashCommentExtension）。

## Sidebar modules

各ツールは `*Mod.jsx` として自己完結したコンポーネントで実装し、
`src/components/common/ModuleWrapper.jsx`（折り畳みコンテナ）でラップする。
新しいサイドバーツールを追加するには `*Mod.jsx` を作成し、`src/components/sidebar/SidebarBox.jsx` に登録するだけ。

`ModuleWrapper` の `keepMounted` prop：折り畳み時でも動作させ続けたいタイマー系モジュール
（Pomodoro / FlowTime）に設定する。他のモジュールは折り畳み時にアンマウントされ、
不要な再レンダリングを防ぐ（#28 対応）。

## Virtualization

- `virtua` ライブラリ（インストール済み）を使って読み取り専用の大量リストを仮想化する。
- `src/components/common/VirtualList.jsx` が共通仮想化コンポーネント。
- 対象：DiffMode の差分行 / エクスプローラーのファイルツリー / FindReplace 結果 / HeadingJump（#26 系）。
- **WriteMode（TipTap）への仮想化は行わない**（ProseMirror の position-based tree と非互換）。

## Sync / Worker

- `src/lib/sync.js` — クロスデバイス同期ロジック（ファイル単位の push/pull）。
- `src/lib/workerClient.js` — Cloudflare Worker へのフェッチラッパー。
- `worker/` — Cloudflare Worker（Hono フレームワーク）の同期サーバー。デプロイは `wrangler`。

### GitHub 連携の設計原則

**「GitHub の状態を正とする」原則**: GitHub 上で状態が変化した後（ブランチ切り替え・PR マージ等）は、ローカル IndexedDB を GitHub から pull して上書きする。ローカルの変更は GitHub に push してからローカルを更新する。

**同期フロー**:
1. 編集 → 3秒デバウンス → `syncFileSilent()` で GitHub に push（`src/lib/sync.js`）
2. ブランチ切り替え → `getFileContent(owner, repo, path, newBranch)` で GitHub から pull → IndexedDB 更新
3. PR マージ → GitHub API でマージ → base ブランチを自動 pull（ブランチ切り替えと同じフロー）
4. コンフリクト → `conflictData` state でユーザーに解決を委ねる（`src/context/AppContext.jsx`）

**ローカル変更の保護**: ブランチ切り替えまたはリモート pull 時に `isDirty === true` の場合は `window.confirm` でユーザー確認を取ってから上書きする。

**GitHub API プロキシ**: フロントエンドは直接 GitHub API を呼ばず、`worker/src/github-proxy.ts` のホワイトリスト経由で安全にアクセスする（`/github/*` ルート）。

## Theming

`<html>` の `data-theme` 属性で dark（デフォルト）/ light を切り替える。
CSS カスタムプロパティ（`--bg`, `--tx`, `--ac` 等）は `src/index.css` で定義。CSS-in-JS は使わない。

## Writing rules

`src/lib/writingRules.js` — 設定可能なテキスト変換（空白・インデント等）をエディタ内容に適用。
