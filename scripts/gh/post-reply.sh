#!/usr/bin/env bash
# post-reply.sh <種別> <IDまたはPR番号> <返信本文> [PR番号]
# 種別: "inline" = インラインコメントへの返信（第4引数にPR番号が必要）
#        "pr_level" = PRレベルコメントへの返信
# 例: bash post-reply.sh inline 3254209547 "対応しました（commit: abc1234）" 77
# 例: bash post-reply.sh pr_level 77 "見送ります。理由：..."
set -euo pipefail

type=${1:?種別を指定してください (inline|pr_level)}
id=${2:?IDを指定してください}
body=${3:?返信本文を指定してください}
pr_number=${4:-}

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

if [[ "$type" == "inline" ]]; then
  [[ -z "$pr_number" ]] && { echo "エラー: inline返信にはPR番号（第4引数）が必要です" >&2; exit 1; }
  gh api -X POST "repos/$repo/pulls/$pr_number/comments/$id/replies" -f body="$body"
elif [[ "$type" == "pr_level" ]]; then
  gh api -X POST "repos/$repo/issues/$id/comments" -f body="$body"
else
  echo "エラー: 種別は inline または pr_level を指定してください" >&2
  exit 1
fi
