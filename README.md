# 小説専用IDE

作家が執筆に専念できる、開発者のIDEのような集中感・快適感を目指したエディタ。

**Git管理された創作文書リポジトリを小説執筆・設計・校正・AIワークフローに最適化して表示・編集・レビューできるIDE**として設計されています。本文・設計カード・スタイルリファレンスは Markdown/JSON 等の可読ファイルとして管理するため、novel-ide がなくても VSCode・GitHub・Obsidian 等から読むことができます。

GitHub連携・クロスデバイス同期・豊富なサイドバーツールを備え、
ブラウザ上でそのまま動作します。

---

## 主な機能

### 執筆モード

| モード | 説明 |
|--------|------|
| **書く** | TipTap/ProseMirror ベースのリッチエディタ。ルビ・コメント・インライン注釈に対応 |
| **プレビュー** | Markdown レンダリング + アノテーションオーバーレイ |
| **差分** | 保存済みスナップショットとの Myers diff 比較 |
| **構成** | ドラッグ＆ドロップで段落を並べ替え |

### サイドバーツール

- 文字数カウント（目標設定・グラフ付き）
- ポモドーロタイマー / フロータイム
- 検索・置換
- 見出しジャンプ
- 校正支援（繰り返し表現・読点過多など）
- タグ管理
- アノテーション（ハイライト・メモ）
- 執筆ルール設定

### その他

- **GitHub 連携**：ファイルを GitHub リポジトリに直接コミット・プル
- **クロスデバイス同期**：Cloudflare Worker 経由でデバイス間のファイルを同期
- **ダーク / ライトテーマ**
- **フォント・行間・文字間隔のカスタマイズ**
- **PDF エクスポート**

---

## 開発者向け

### セットアップ

```bash
npm install
npm run dev       # Vite 開発サーバー（HMR）
```

本番ビルド：

```bash
npm run build
npm run preview   # ビルド結果のローカル確認
```

### コマンド一覧

```bash
npm run dev       # 開発サーバー起動
npm run build     # 本番ビルド
npm run lint      # ESLint
npm run preview   # ビルドプレビュー
npm run test      # ユニットテスト（node --test）
```

Cloudflare Worker（同期サーバー）：

```bash
cd worker
npm run dev       # wrangler dev
npm run deploy    # Cloudflare へデプロイ
```

### ディレクトリ構造

```
src/
├── components/
│   ├── common/          # 共通UIコンポーネント（ModuleWrapper, VirtualList）
│   ├── editor/          # エディタ本体（EditorBox, WriteMode, PreviewMode, DiffMode, StructureMode）
│   ├── footer/          # フッター（フォーマットツールバー、ナビゲーション）
│   ├── header/          # ヘッダー（ファイルドロップダウン、同期バッジ）
│   ├── modals/          # モーダルダイアログ（設定、GitHub、エクスポート等）
│   ├── sidebar/         # サイドバーモジュール（各*Mod.jsx + SidebarBox.jsx）
│   └── system/          # システムコンポーネント（UIPersistence等）
├── context/
│   └── AppContext.jsx   # ファイル・フォルダ・設定の状態管理（Zustand移行中）
├── hooks/               # カスタムフック
├── lib/                 # ビジネスロジック・ユーティリティ
│   ├── db.js            # IndexedDB ラッパー
│   ├── sync.js          # クロスデバイス同期
│   ├── github.js        # GitHub API クライアント
│   ├── diffCore.js      # Myers diff アルゴリズム
│   ├── markdown.js      # Markdown → HTML パーサー
│   ├── tiptap/          # TipTap カスタム拡張
│   └── writingRules.js  # 執筆ルール変換
├── stores/              # Zustand ストア（uiStore など）
└── workers/             # Web Worker（diffWorker.js）
worker/                  # Cloudflare Worker（Hono）同期サーバー
tests/                   # ユニットテスト（node --test）
docs/                    # 開発ドキュメント
```

### アーキテクチャの詳細

詳細なアーキテクチャ・設計方針・AIエージェント向け情報は [CLAUDE.md](CLAUDE.md) を参照。

MVP 段階定義（Alpha/Beta/Gamma/Delta）は [docs/MVP_PLAN.md](docs/MVP_PLAN.md) を参照。MVP Alpha の操作メモは [docs/MVP_GETTING_STARTED.md](docs/MVP_GETTING_STARTED.md)。
将来構想・機能マップ（旧ロードマップ）は [docs/FUTURE_MAP.md](docs/FUTURE_MAP.md) を参照（実装順ではない）。

### 環境変数・デプロイ設定

ローカル開発・デプロイに必要な設定値は [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) を参照。

### コントリビューション

レビュー方針は [docs/REVIEW_GUIDELINES.md](docs/REVIEW_GUIDELINES.md) を参照。
