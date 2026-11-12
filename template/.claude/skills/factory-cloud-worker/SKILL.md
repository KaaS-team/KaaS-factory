---
name: factory-cloud-worker
description: The contract for a cloud coding session working one ticket: branch naming, test-first order, checkpoints before each commit, never touching workflow files, and the final report pushed to its own branch. Use when a brief says "use factory-cloud-worker", so the brief can be the ticket alone.
---

# factory-cloud-worker

The brief gives you the ticket (`<t>` is its slug). This skill is everything else.

## Branch

Work on `factory/<t>-a<n>`, where `<n>` is the attempt number (1 on the first try). Create it from the
base branch the ticket names. Commit with `git commit -s`, one commit per acceptance line, and push
after each with `git push -u origin factory/<t>-a<n>`. Never force-push, and never push to the base
branch or the default branch.

## Order of work

For each acceptance line: write the test, watch it fail, write the code, watch it pass. A test you
never saw fail proves nothing. Run the repo's fast gate before every push and its full gate before the
last one. Chain the gate and the push with `&&`, never `;`.

## Checkpoints, before every commit

1. Area: every changed file is in the area the ticket names, or goes under "Files outside my area".
2. Scope: the diff serves only an acceptance line. No refactor elsewhere, no extra feature.
3. Meaning: each acceptance line still means what it says. If it cannot be met, record it blocked;
   never weaken it.
4. Proof: you saw each new test fail before the code and pass after.
5. No network, real token or model call in any test. Use fakes or a local test server.

## Rules

- Never touch `.github/workflows/**`. Cloud sessions cannot push it; list the change you want in the
  report for a local session.
- No provider key in code, tests or environment. No model name, token count or cost in any commit,
  file or report.
- No session link and no session trailer in any commit or file.
- Do not comment on, label or close issues, and do not open a pull request unless the ticket says so.
- If one acceptance line is blocked, record why and continue with the next.
- No em dashes in prose. Plain sentences.

## Report format

When you finish, write this report to a file outside the repo. Keep the headings exactly.

```
BRANCH: factory/<t>-a<n>
HEAD: <full sha you pushed, checked with git ls-remote>
## Summary
<one or two sentences>
## Acceptance
- <line> -> <test name> -> done | blocked (why)
## API change requests
<each, or none>
## Files outside my area
<each, with why, or none>
## Gate evidence
<last lines of the full gate, verbatim>
## Learnings
<what cost time; what the defaults should do instead. One line each.>
```

## Push the report

The supervisor's log cuts long messages short, and a repo hook refuses writes under `.factory/`, so push
the report to its own branch with git plumbing, never into the tree:

```
b=$(git hash-object -w /tmp/report.md); t=$(printf '100644 blob %s\treport.md\n' "$b" | git mktree); c=$(git commit-tree "$t" -m report); git push origin "$c:refs/heads/report/<t>"
```

## Final message

Your final message is the report, exactly as pushed, with nothing before or after it.
