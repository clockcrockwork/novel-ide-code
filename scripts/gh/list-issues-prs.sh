#!/usr/bin/env bash
# list-issues-prs.sh
# オープンなissueとPRを一括取得し、関連付け情報を付与してJSONで出力する
# 出力: { issues: [...], prs: [...] }
# pick-issue ワークフロー（docs/agent-workflows/pick-issue.md）で使用する
# issue の body フィールドを含む（依存関係解析用）
set -euo pipefail

repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

issues_raw=$(gh api --paginate "repos/$repo/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request == null) | {
    number,
    title,
    body: (.body // ""),
    labels: ([.labels[].name] | join(", ")),
    assignees: ([.assignees[].login] | join(", ")),
    created_at,
    url: .html_url
  }' | jq -s '.')

prs_raw=$(gh api --paginate "repos/$repo/pulls?state=open&per_page=100" \
  --jq '.[] | {number, title, branch: .head.ref, body, state, url: .html_url, created_at}' \
  | jq -s '.')

jq -n --argjson issues "$issues_raw" --argjson prs "$prs_raw" '
  ($prs | reduce .[] as $pr (
    {};
    . as $map |
    ([$pr.title, $pr.branch, ($pr.body // "")] | join(" ") |
     [scan("#([0-9]+)") | .[0] | tonumber]) as $nums |
    reduce $nums[] as $n (
      $map;
      .[$n | tostring] += [$pr.number]
    )
  )) as $linked |
  {
    issues: ($issues | map(
      . + {
        linked_prs: (($linked[(.number | tostring)] // []) | unique),
        status: (if ($linked[(.number | tostring)] | length) > 0 then "対応中" else "未着手" end)
      }
    ) | sort_by(.number)),
    prs: ($prs | sort_by(.number))
  }
'
