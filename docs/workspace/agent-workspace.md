# Agent Workspace 運用ガイド

public code repo（novel-ide）と private control repo（novel-ide-control）を分離した後、
AIエージェントが両リポジトリを1作業単位として扱えるようにするための運用ガイド。

---

## 推奨ディレクトリ構成

```
~/repos/
  novel-ide/              # public code repo（クローン済み）
  novel-ide-control/      # private control repo（クローン済み）

~/worktrees/
  novel-ide/
    issue-325/
      AGENTS.md           # 作業ルートのエージェント指示（自動生成）
      code/               # novel-ide の worktree
      control/            # novel-ide-control の worktree
```

作業ルート（`issue-XXX/`）をエージェントの `--context` または作業ディレクトリとして渡す。

---

## worktree の作成

`scripts/new-worktree.sh` を使う。

```bash
# 基本用法（code 側ブランチ名は claude/work-<乱数> を自動生成）
./scripts/new-worktree.sh <issue-number>

# code 側ブランチ名を明示する場合（private Issue 番号を含めないこと）
./scripts/new-worktree.sh <issue-number> <code-branch-name>

# 例
./scripts/new-worktree.sh 325
./scripts/new-worktree.sh 325 claude/feat-style-check
```

スクリプトは以下を行う：

1. `~/worktrees/novel-ide/issue-<N>/` を作成（ローカルのディレクトリ名は番号を含んでよい）
2. `~/repos/novel-ide` から `code/` worktree を作成し、**issue 番号を含まない** public ブランチを切る（`claude/work-<乱数>` または第2引数で指定）
3. `~/repos/novel-ide-control` から `control/` worktree を作成し、private ブランチ `claude/issue-<N>` を切る
4. 作業ルートに `AGENTS.md` を生成する

> **ブランチ命名方針**: public(code) 側ブランチ名は public PR 上に露出するため、private Issue 番号を含めない。
> private Issue との紐付けは control 側ログに記録する（後述）。control(private) 側ブランチは番号を含めてよい。
> repo パスは `NOVEL_IDE_CODE_REPO` / `NOVEL_IDE_CONTROL_REPO`、control 側プレフィックスは `CONTROL_BRANCH_PREFIX` 環境変数で上書きできる。

---

## 作業ルート AGENTS.md テンプレート

スクリプトが以下の内容で `AGENTS.md` を生成する（`<N>` は issue 番号、ブランチ名は実際の値が埋め込まれる）。

```markdown
# エージェント workspace ポリシー — issue #<N>

このワークスペースには2つのリポジトリが含まれます。

- `code/`: public ソースリポジトリ（novel-ide / ブランチ `<code-branch>`）
- `control/`: private 計画リポジトリ（novel-ide-control / ブランチ `claude/issue-<N>`）

## 読み書きルール

| 場所 | 読み取り | 書き込み |
|------|---------|---------|
| `code/` | ○ | ○（ソースコード変更） |
| `control/` | ○ | ○（要件・メモ・レビューログの更新のみ） |
| `~/.claude/` 等の設定 | ○（参照のみ） | × |

## 禁止事項

- `control/` 配下のファイルパス・要件文・private Issue 番号を public PR 本文 / コミットメッセージ / コメント / **ブランチ名** に含めない
- `code/` の変更と `control/` の変更を1コミットに混在させない
- `control/` の内容を要約・言い換えであっても public PR に転載しない

## commit 分離

- `code/` 配下の変更 → `code/` ディレクトリ内で `git commit`
- `control/` 配下の変更 → `control/` ディレクトリ内で `git commit`

## docs の場所

- 実装仕様・アーキテクチャ: `code/docs/`
- 要件・設計決定・レビューログ: `control/`（private）
```

---

## public PR に private 情報を出さないルール

### 禁止

- `control/` 配下のファイルパスをそのまま記載する
- private Issue の番号（例: `#12`）を public PR 本文・**ブランチ名**に書く
- 要件文・設計メモを要約・言い換えしても転載する

### 許可

- 実装内容のサマリ（何を変えたか、なぜ変えたか）
- `code/` 配下のファイルパス・関数名
- テスト結果・パフォーマンス計測値

### PR 本文の書き方

public PR には実装の観点から書く。private 要件が背景にある場合も、
「何を実装したか」「どう動くか」「なぜこの設計を選んだか」を中心に記述する。

```markdown
## 変更概要

- `src/components/Foo.jsx` に〇〇機能を追加
- IndexedDB の `files` ストアに `bar` フィールドを追加

## 設計上の判断

パフォーマンス上の理由から〇〇アプローチを採用。
```

---

## private Issue ↔ public PR のリンク方法

### public PR 側（novel-ide）

private Issue の番号・タイトル・URL は記載しない。ブランチ名にも番号を含めない（`claude/work-<乱数>` 等）。
関連がある場合は、実装上の関心事を実装者視点で書けば十分。

### control 側（novel-ide-control）

Issue ログや設計メモに public PR の URL と code 側ブランチ名を記録する。

```markdown
## 実装記録

- public PR: https://github.com/clockcrockwork/novel-ide/pull/XXX
- code ブランチ: claude/work-1a2b3c4d
- 対応内容: 〇〇機能の実装
- 決定事項: 〇〇の理由で△△を採用
```

これにより private 側から public PR を追跡できる。逆向きのリンク（public → private 番号）は露出しない。

---

## エージェントが参照すべき docs

| 目的 | 参照先 |
|------|--------|
| 実装仕様・コンポーネント構成 | `code/docs/ARCHITECTURE.md` |
| MVP 段階定義（実装優先度） | `code/docs/MVP_PLAN.md` |
| レビュー方針 | `code/docs/REVIEW_GUIDELINES.md` |
| セキュリティ・信頼境界 | `code/docs/security/` |
| データモデル不変条件 | `code/docs/data-model/INVARIANTS.md` |
| 定型ワークフロー手順 | `code/docs/agent-workflows/` |
| 要件・設計決定・過去ログ | `control/`（private） |

実装に迷ったら `code/docs/ARCHITECTURE.md` → `code/docs/MVP_PLAN.md` の順で参照する。

---

## commit 分離ルール

### 原則

1コミット = 1リポジトリ。`code/` の変更と `control/` の変更は必ず別コミットにする。

### 手順

```bash
# ソースコードを変更したら code/ から commit
cd ~/worktrees/novel-ide/issue-325/code
git add src/...
git commit -m "feat: 〇〇を実装"

# 要件メモ・設計ログを更新したら control/ から commit
cd ~/worktrees/novel-ide/issue-325/control
git add issues/...
git commit -m "log: issue-325 設計決定メモを追記"
```

### push と PR

- `code/` の変更 → `novel-ide` に push → public PR を作成
- `control/` の変更 → `novel-ide-control` に push → private PR または直接 push（運用に従う）

---

## worktree の片付け

作業完了後は worktree を削除する。未コミット変更や未プッシュコミットがある場合は `--force` が必要。

```bash
cd ~/repos/novel-ide
git worktree remove --force ~/worktrees/novel-ide/issue-325/code

cd ~/repos/novel-ide-control
git worktree remove --force ~/worktrees/novel-ide/issue-325/control

rm -rf ~/worktrees/novel-ide/issue-325
```
