#!/usr/bin/env bash
# worktree 作成: ~/worktrees/novel-ide/issue-<N>/{code,control,AGENTS.md}
#
# 使い方: new-worktree.sh <issue-number> [code-branch-name]
#   <issue-number>     : 作業ルートのディレクトリ名と control(private) 側ブランチに使う
#   [code-branch-name] : public(code) 側ブランチ名。private Issue 番号を含めないこと。
#                        省略時は claude/work-<乱数> を自動生成する。
#
# 環境変数で repo パスを上書き可能:
#   NOVEL_IDE_CODE_REPO     (既定: ~/repos/novel-ide)
#   NOVEL_IDE_CONTROL_REPO  (既定: ~/repos/novel-ide-control)
#   NOVEL_IDE_BASE_BRANCH   (既定: origin/main)
#   CONTROL_BRANCH_PREFIX   (既定: claude/issue-)

set -euo pipefail

ISSUE="${1:-}"

if [[ -z "$ISSUE" ]]; then
  echo "使い方: $0 <issue-number> [code-branch-name]" >&2
  exit 1
fi

if ! [[ "$ISSUE" =~ ^[1-9][0-9]*$ ]]; then
  echo "エラー: issue-number は正の整数を指定してください" >&2
  exit 1
fi

CODE_REPO="${NOVEL_IDE_CODE_REPO:-${HOME}/repos/novel-ide}"
CONTROL_REPO="${NOVEL_IDE_CONTROL_REPO:-${HOME}/repos/novel-ide-control}"
WORKTREE_ROOT="${HOME}/worktrees/novel-ide/issue-${ISSUE}"

# control(private) 側は issue 番号を含めてよい。code(public) 側は含めない。
CONTROL_BRANCH="${CONTROL_BRANCH_PREFIX:-claude/issue-}${ISSUE}"
CODE_BRANCH="${2:-claude/work-$(printf '%04x%04x' "$RANDOM" "$RANDOM")}"
BASE_BRANCH="${NOVEL_IDE_BASE_BRANCH:-origin/main}"
# BASE_BRANCH からリモート名を抽出（例: origin/main → origin, main → origin）
REMOTE="${BASE_BRANCH%%/*}"
[[ "$REMOTE" == "$BASE_BRANCH" ]] && REMOTE="origin"

# 第2引数で明示したブランチ名にのみ番号混入チェックを適用する。
# 自動生成名（乱数16進）は意図的に番号を含まないため対象外。
# パターンは変数に代入してから =~ で比較する（クォートするとリテラル扱いになるため）。
issue_pattern="(^|[^0-9])${ISSUE}([^0-9]|$)"
if [[ -n "${2:-}" && "$CODE_BRANCH" =~ $issue_pattern ]]; then
  echo "エラー: code 側ブランチ名に private Issue 番号 (${ISSUE}) を含めないでください: ${CODE_BRANCH}" >&2
  exit 1
fi

if ! git -C "${CODE_REPO}" rev-parse --git-dir &>/dev/null; then
  echo "エラー: code repo が見つかりません: ${CODE_REPO}" >&2
  exit 1
fi
if ! git -C "${CONTROL_REPO}" rev-parse --git-dir &>/dev/null; then
  echo "エラー: control repo が見つかりません: ${CONTROL_REPO}" >&2
  exit 1
fi

if [[ -e "${WORKTREE_ROOT}" || -L "${WORKTREE_ROOT}" ]]; then
  echo "エラー: worktree がすでに存在します: ${WORKTREE_ROOT}" >&2
  exit 1
fi

cleanup() {
  [[ -n "${code_fetch_pid:-}" ]] && kill "${code_fetch_pid}" 2>/dev/null || true
  [[ -n "${control_fetch_pid:-}" ]] && kill "${control_fetch_pid}" 2>/dev/null || true
  git -C "${CODE_REPO}" worktree remove --force "${WORKTREE_ROOT}/code" 2>/dev/null || true
  git -C "${CONTROL_REPO}" worktree remove --force "${WORKTREE_ROOT}/control" 2>/dev/null || true
  git -C "${CODE_REPO}" worktree prune 2>/dev/null || true
  git -C "${CONTROL_REPO}" worktree prune 2>/dev/null || true
  rm -rf "${WORKTREE_ROOT}"
}
trap cleanup ERR

# 既存ブランチがあれば再利用、リモートにあれば追跡して作成、なければ BASE_BRANCH を起点に新規作成
# --no-track: upstream を BASE_BRANCH に設定しない（push は git push -u origin <branch> で明示的に行う）
add_worktree() {
  local repo="$1" path="$2" branch="$3"
  if git -C "${repo}" show-ref --verify --quiet "refs/heads/${branch}"; then
    git -C "${repo}" worktree add "${path}" "${branch}"
  elif git -C "${repo}" show-ref --verify --quiet "refs/remotes/${REMOTE}/${branch}"; then
    git -C "${repo}" worktree add -b "${branch}" "${path}" "${REMOTE}/${branch}"
  else
    git -C "${repo}" worktree add --no-track -b "${branch}" "${path}" "${BASE_BRANCH}"
  fi
}

echo "issue #${ISSUE} の worktree を作成しています..."
echo "  code(public)  ブランチ: ${CODE_BRANCH}"
echo "  control(priv) ブランチ: ${CONTROL_BRANCH}"
mkdir -p "${WORKTREE_ROOT}"

# fetch は並列。いずれか失敗したら ERR trap で中断（stale base からの作成を防ぐ）
git -C "${CODE_REPO}" fetch "${REMOTE}" & code_fetch_pid=$!
git -C "${CONTROL_REPO}" fetch "${REMOTE}" & control_fetch_pid=$!
wait "${code_fetch_pid}"; code_fetch_pid=""
wait "${control_fetch_pid}"; control_fetch_pid=""

add_worktree "${CODE_REPO}" "${WORKTREE_ROOT}/code" "${CODE_BRANCH}"
add_worktree "${CONTROL_REPO}" "${WORKTREE_ROOT}/control" "${CONTROL_BRANCH}"

cat > "${WORKTREE_ROOT}/AGENTS.md" << AGENTS_EOF
# エージェント workspace ポリシー — issue #${ISSUE}

このワークスペースには2つのリポジトリが含まれます。

- \`code/\`: public ソースリポジトリ（novel-ide / ブランチ \`${CODE_BRANCH}\`）
- \`control/\`: private 計画リポジトリ（novel-ide-control / ブランチ \`${CONTROL_BRANCH}\`）

## 読み書きルール

| 場所 | 読み取り | 書き込み |
|------|---------|---------|
| \`code/\` | ○ | ○（ソースコード変更） |
| \`control/\` | ○ | ○（要件・メモ・レビューログの更新のみ） |
| \`~/.claude/\` 等の設定 | ○（参照のみ） | × |

## 禁止事項

- \`control/\` 配下のファイルパス・要件文・private Issue 番号を public PR 本文 / コミットメッセージ / コメント / **ブランチ名** に含めない
- \`code/\` の変更と \`control/\` の変更を1コミットに混在させない
- \`control/\` の内容を要約・言い換えであっても public PR に転載しない

## commit 分離

- \`code/\` 配下の変更 → \`code/\` ディレクトリ内で \`git commit\`
- \`control/\` 配下の変更 → \`control/\` ディレクトリ内で \`git commit\`

## docs の場所

- 実装仕様・アーキテクチャ: \`code/docs/\`
- 要件・設計決定・レビューログ: \`control/\`（private）

## private Issue ↔ public PR のリンク

- public 側（PR・ブランチ名）には issue #${ISSUE} を出さない
- \`control/\` 側のログに public PR / ブランチ \`${CODE_BRANCH}\` を記録して紐付ける
AGENTS_EOF

trap - ERR

echo ""
echo "完了: ${WORKTREE_ROOT}"
echo ""
echo "  ${WORKTREE_ROOT}/"
echo "    AGENTS.md"
echo "    code/    (ブランチ: ${CODE_BRANCH})"
echo "    control/ (ブランチ: ${CONTROL_BRANCH})"
echo ""
echo "private Issue ↔ public PR のリンクのため、control 側ログに"
echo "code ブランチ名 (${CODE_BRANCH}) を記録してください。"
echo ""
echo "作業完了後の片付け:"
echo "  git -C \"${CODE_REPO}\" worktree remove --force \"${WORKTREE_ROOT}/code\""
echo "  git -C \"${CONTROL_REPO}\" worktree remove --force \"${WORKTREE_ROOT}/control\""
echo "  rm -rf \"${WORKTREE_ROOT}\""
