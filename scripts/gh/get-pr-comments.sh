#!/usr/bin/env bash
# get-pr-comments.sh <PR番号>
# gh api --paginate で全コメントを取得し、種別・ファイル・行番号順に整形して標準出力へ JSON で出力する
# resolved は REST API の制限により常に false。threads API で個別確認が必要な場合は
# gh pr view {PR番号} --json reviewThreads を使うこと
set -euo pipefail

pr_number=${1:?PR番号を指定してください}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

inline=$(gh api --paginate "repos/$repo/pulls/$pr_number/comments" \
  --jq '.[] | {id, type: "inline", reviewer: (.user?.login // "ghost"), body, path, line: (.line // .original_line), resolved: false, url: .html_url, created_at}' \
  | jq -s '.')

pr_level=$(gh api --paginate "repos/$repo/issues/$pr_number/comments" \
  --jq '.[] | {id, type: "pr_level", reviewer: (.user?.login // "ghost"), body, path: null, line: null, resolved: false, url: .html_url, created_at}' \
  | jq -s '.')

reviews=$(gh api --paginate "repos/$repo/pulls/$pr_number/reviews" \
  --jq '.[] | select(.body != null and .body != "") | {id, type: "review", reviewer: (.user?.login // "ghost"), body, path: null, line: null, resolved: false, url: .html_url, created_at: .submitted_at}' \
  | jq -s '.')

jq -n --argjson a "$inline" --argjson b "$pr_level" --argjson c "$reviews" \
  '($a + $b + $c) | sort_by([.path, .line, .created_at])'
