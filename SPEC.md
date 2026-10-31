<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E2 Reliability
Milestone: Phase 1 reliability
Runner: operator

#
## Non-goals
Do not touch .github/workflows (stage any CI change under ci/ and say so in the PR). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## How to ship
One PR from branch feat/<name>. Commits use `git commit -s`. PR body uses every section of .github/pull_request_template.md, filled with real evidence (the gate output, not "pending"). Run `python3 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry in tests/mutations.json is {name,file,find,replace,test}; its `find` must match exactly once in its file, and the test must fail under the replacement. Never put a session link in a commit or PR.
