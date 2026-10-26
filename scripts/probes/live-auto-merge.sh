#!/bin/bash
# One task went from a command sent through the control plane (the phone's path) to
# a pull request the merge policy merged by itself: a merged PR carrying the auto audit comment
# whose issue carries a comment signed by the control plane.
set -euo pipefail
repo=${FACTORY_PROBE_REPO:?set FACTORY_PROBE_REPO to the owner/name the factory works on}
for pr in $(gh pr list -R "$repo" --state merged --limit 50 --json number --jq '.[].number'); do
  gh api "repos/$repo/issues/$pr/comments" --paginate --jq '.[].body' | grep -q 'Merge policy: \*\*auto\*\*' || continue
  for issue in $(gh pr view "$pr" -R "$repo" --json closingIssuesReferences --jq '.closingIssuesReferences[].number'); do
    if gh api "repos/$repo/issues/$issue/comments" --paginate --jq '.[].body' | grep -q 'Sent from the factory control plane by @'; then
      echo "PR #$pr auto-merged issue #$issue, started from the control plane"
      exit 0
    fi
  done
done
echo "no merged PR on $repo was auto-merged from a task sent through the control plane" >&2
exit 1
