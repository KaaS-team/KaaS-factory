BRANCH: cluster/v7.1-brand-footer
HEAD: bffe264f03284a76110749e72ef5f113c0c738e6
## Summary
PR bodies now end with a configurable kaas.team footer, every factory commit carries a Shipped-with trailer, `--version` prints the kaas.team link, and a test with mutations rejects model names and dollar figures in these lines. The "table of every public repo" half of the README line is blocked: this session cannot list other repos.
## Issues
- #210: partly done, one half blocked.
  - Footer: tests/brand.test.ts "every PR body ends with the footer linking to kaas.team" and "the footer is configurable..." -> tests/mutations/every-pr-body-ends-without-the-brand-footer.json. A footer without the link is refused: "a footer without the kaas.team link is refused" -> a-footer-without-the-kaas-team-link-is-accepted.json.
  - Trailer: "a factory commit carries Shipped-with, for commit and commit-tree" (plus the updated tests/signoff.test.ts) -> a-factory-commit-drops-the-shipped-with-trailer.json.
  - --version: "prints the version and the kaas.team link" (and tests/binary.test.ts) -> version-text-drops-the-kaas-team-link.json.
  - README template: docs/readme-template.md has a "Built by KaaS" block and a repo table. Tests: "README template" block in tests/brand.test.ts, mutation n/a. BLOCKED part: the table has only this repo's row. The session's GitHub scope is this repo, so I could not read other public repos' descriptions.
  - Security policy: already held. SECURITY.md exists on the base with a Reporting section. I changed no code. Test "SECURITY.md is a policy" is a guard, mutation n/a.
  - Model name or dollar figure: "no model name or cost in the brand lines" tests -> the-brand-check-lets-a-model-name-through.json and the-brand-check-lets-a-dollar-figure-through.json.
  - All six mutations were reported as caught by check-mutations.
## Staged workflow changes
none
## Checkpoints
#210: 1 no (see Files outside my area, each is the smallest edit). 2 yes. 3 yes, except the repo table, recorded as blocked. 4 the mutation files show each test fails when its fix is removed. 5 yes: I raised two line baselines by 1 and 2 lines (steps.ts 540 to 541, config.ts 787 to 789), as the tool requires. 6 yes: pr-body, signoff, binary and acceptance-table tests pass. 7 yes.
## Files outside my area
- src/config.ts, src/profile-rules.ts: the `brand.footer` config key and its validation.
- src/engine/steps.ts: passes `config.brand?.footer` to prBody.
- src/cli.ts: `--version` prints VERSION_TEXT (same line count).
- quality-baseline/lines/src__config.ts.json, src__engine__steps.ts.json: line baselines.
- tests/mutations.json: the old "pr body: run summary returns to the body" entry's find text changed because the function's last line did.
- tests/acceptance-table.test.ts, tests/binary.test.ts, tests/signoff.test.ts: expectations updated for the footer, the version text and the trailer. The "none" sign-off mode now still carries Shipped-with, which the acceptance requires.
- docs/readme-template.md: new file.
## Gate evidence
make fast: ok
Full `make test`: 4268 pass, 0 fail, no Unhandled error block.
## Risk and rollback
Low. Every PR body gains a footer and every commit one trailer. Revert the branch to roll back.
## Learnings
- `make fast` fails on line baselines in quality-baseline/lines/ whenever a capped file grows; the brief should say to bump the shard.
- A mutation in tests/mutations.json that spans a function's last line breaks when it changes; grep tests/mutations.json for the file before editing.
- tests/binary.test.ts pins the exact `--version` output.
- `make test` takes about 4 minutes; use run_in_background or an until-loop.
- The session cannot list the org's repos, so the repo table cannot be built from here.
