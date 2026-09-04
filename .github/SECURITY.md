# セキュリティポリシー

## 脆弱性の報告

脆弱性を発見した場合は、**公開 issue を立てずに** 以下の方法で報告してください。

1. GitHub の [Security] タブ → [Report a vulnerability] から非公開で報告する
2. または、リポジトリオーナーに直接連絡する

---

## 対応方針

| 深刻度 | 目安対応期間 |
|--------|------------|
| Critical | 発見次第最優先対応 |
| High | 次のスプリント以内 |
| Medium | 通常の issue フローで管理 |
| Low | バックログで管理 |

---

## このプロジェクトの主な攻撃面

- **Markdown プレビュー**: ユーザー入力を HTML に変換して表示する（XSS リスク）
- **Cloudflare Worker 同期エンドポイント**: 認証・パストラバーサル・CSRF
- **GitHub トークン**: ブラウザ側での保持、Worker 側での KV ストレージ

詳細なレビュー観点は [docs/REVIEW_GUIDELINES.md](../docs/REVIEW_GUIDELINES.md) を参照。

---

## 既知の未対応脆弱性

現時点で未対応の既知脆弱性はありません。

過去に報告・対応した代表的なセキュリティ修正：

| issue | 深刻度 | 内容 | 状態 |
|-------|--------|------|------|
| #49 | Critical | markdown.js のルビ変換で XSS が可能だった | 対応済み（変換前に `esc()` を適用） |
| #50 | High | sync エンドポイントでパストラバーサルが可能だった | 対応済み（`FILE_ID_RE` で ID 検証） |
| #51 | Medium | sync エンドポイントに CSRF トークン検証がなかった | 対応済み（`validateCSRFToken` ミドルウェア） |

---

## npm 脆弱性対応手順

### 発見経路

- **CI audit ジョブ**（`.github/workflows/ci.yml` の `audit` ジョブ）が PR ごとに `--audit-level=high` で high/critical を検出する
- **Dependabot**（`.github/dependabot.yml`）が週次で依存パッケージの脆弱性アラートを発行する
- **手動確認**: `npm audit --omit=dev` / `cd worker && npm audit --omit=dev`

### 対応方針

| 深刻度 | 対象 | 対応方針 |
|--------|------|---------|
| Critical / High | production deps | 即時対応。fix available なら `npm update` で修正。fix なければ代替パッケージを検討 |
| Moderate | production deps | Dependabot PR が来たらレビューして取り込む |
| High / Moderate | dev deps のみ | バックログ管理。Dependabot PR でまとめて対応 |
| Low | 全て | 記録のみ |

production/dev の判定：`npm audit --omit=dev` で検出されるものが production に影響あり。

---

## install scripts 方針

このプロジェクトの依存パッケージ（esbuild 等）は `install` / `postinstall` スクリプトを使用するため、`ignore-scripts=true` はグローバルに設定しない。

`postinstall` / `install` スクリプトを持つパッケージを**新規追加**する場合は、PR チェックリストでスクリプトの内容確認を必須とする。

---

## GitHub Actions secrets 非露出方針

- `secrets.*` は `env:` 経由でのみワークフローに渡す（`run:` ステップに直接展開しない）
- サードパーティ action に secrets を渡す場合は、action の publish 者と用途を PR 説明に明記する
- `GITHUB_TOKEN` の `permissions` はワークフローのトップレベルで `contents: read` をデフォルトとし、追加権限が必要な job のみ job 単位で昇格する
- 本番シークレット（deploy キー等）を渡す action を新規追加する場合は SHA ピンを必須とする

---

## GitHub Actions hardening 方針（public repo 化対応・issue #225）

public repo 化に備えた GitHub Actions のサプライチェーン強化方針。詳細・運用手順は [docs/SUPPLY_CHAIN.md](../docs/SUPPLY_CHAIN.md) 「public repo 化前の GitHub Actions hardening 方針」を正とする。

- **permissions**: トップレベル `contents: read` をデフォルトとする。job 単位で必要最小限のみ昇格。
- **Action SHA pin**: third-party action は full-length commit SHA pin 必須。公式 action も SHA pin する。元タグは `uses:` 末尾コメントに残し、更新は Dependabot/手動で SHA を差し替える。
- **`pull_request_target` 原則禁止**: CI は `pull_request` を使う。例外時は外部 PR コードの checkout/実行・Secrets 露出をしない（詳細は SUPPLY_CHAIN.md）。
- npm publish / Trusted Publishing / npm token 管理は対象外（publish 予定なし）。
