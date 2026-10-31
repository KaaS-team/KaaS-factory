<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E3 Reliability runner
Milestone: Phase 1 reliability
Runner: operator

## Risk: high

## Why
Nothing scans what the agent pushes or posts. A key read from the environment or a file can land in a commit or a PR comment. Issue #354.

## Today
- Pushes go through `src/git.ts`; every comment goes through `postComment` in `src/engine/common.ts`. Read both before you edit. There is no scanner today.

## Change
### T1: the scanner
Files: `src/secret-scan.ts`, `tests/secret-scan.test.ts`
Model: sonnet
1. `src/secret-scan.ts` exports `scanText(text)` returning `{rule, line}[]` (never the matched value) and `redact(text)`. Built-in rules, no dependency: AWS access key id (`AKIA` plus 16 upper-case alphanumerics), GitHub tokens (`ghp_`, `gho_`, `ghs_`, `github_pat_` prefixes), `sk-ant-` keys, Slack `xox[bpas]-` tokens, and a PEM private key header (`-----BEGIN` ... `PRIVATE KEY-----`).
2. When an executable named by the env var `FACTORY_GITLEAKS` exists, also run it on the text via stdin and merge its findings. The built-in rules always run, so the scan works with no binary. State this in a code comment; do not claim gitleaks runs by default.
3. Tests build fake keys at run time (concatenate pieces so no secret-shaped literal sits in the repo): each rule hits, ordinary prose and a 40-char git sha do not, and `redact` removes the value.

### T2: block the push and the comment
Files: `src/engine/common.ts`, `src/git.ts`, `tests/secret-scan-wiring.test.ts`
Model: sonnet
Deps: T1
1. In `postComment`, scan the body first. On a hit, post nothing, and fail the stage with the `needs-human` outcome and a message that names the rule and line, never the value.
2. In the push helper in `src/git.ts`, scan the diff being pushed (`git diff` of the commits not on the remote) and refuse to push on a hit, with the same message.
3. Tests: a seeded fake key in a comment body is never posted (the fake github port records zero calls); a seeded key in a diff blocks the push; a clean body and diff go through.

## Tests
- `tests/secret-scan.test.ts`: [permanent] the rules and redaction.
- `tests/secret-scan-wiring.test.ts`: [permanent] the comment and push gates.

## Mutation
```json
{"name":"secret-scan: post a comment with a key","file":"src/engine/common.ts","find":"scanText(","replace":"[].concat(","test":"tests/secret-scan-wiring.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file as you wrote it.

## Acceptance
- AC-1: each built-in rule finds its fake key and leaves prose alone: checked by `make test FILES=tests/secret-scan.test.ts` (T1)
- AC-2: a comment with a seeded key is never posted: checked by `make test FILES=tests/secret-scan-wiring.test.ts` (T2)
- AC-3: a diff with a seeded key blocks the push: checked by `make test FILES=tests/secret-scan-wiring.test.ts` (T2)

## Non-goals
Do not touch .github/workflows (stage workflow edits under ci/). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `src/secret-scan.ts`
- `tests/secret-scan.test.ts`
- `src/engine/common.ts`
- `src/git.ts`
- `tests/secret-scan-wiring.test.ts`

## How to ship
One PR from branch feat/s-secret-scan. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry is {name,file,find,replace,test}; its `find` matches exactly once and the test must fail under the replacement. Put new mutations in a shard file `tests/mutations/s-secret-scan.json`, never in tests/mutations.json. Never put a session link in a commit or PR.
