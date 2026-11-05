BRANCH: cluster/v7.0-trackers
HEAD: ad3872ddbad8d62a63eba277818225355d95e227
## Summary
Added declared CLI tools with a `cli` step (#596), a generic mapping-driven tracker over MCP with a `factory tools` probe and three example mappings (#597), and the same mapping over a declared CLI tool (#598). Trackers are now built through the plugin registry in `src/scm.ts`.
## Issues
- #596: done.
  - Config lists tools by name, command and expected output -> `tests/cli-step.test.ts` "a config lists tools by name, command and expected output" -> `cli-step-output-that-misses-the-declared-expectation-passes.json`, `cli-step-the-tool-gets-the-runner-s-whole-environment.json`.
  - A `cli` step runs a declared tool and records its output -> "the step's fact is the tool's stdout, and the tool never sees a runner token" and "a cli step runs the declared tool..." -> `cli-step-the-cli-step-type-is-not-registered.json`.
  - An undeclared tool is refused with its name -> "an undeclared tool is refused with its name" -> `cli-step-an-undeclared-tool-is-run-instead-of-refused.json`.
  - Declared, undeclared and failing command covered -> the tests above plus "a failing command parks the issue failed with its output" -> `cli-step-a-non-zero-exit-passes.json`.
- #597: done.
  - Mapping says how to list, read, update -> `tests/tracker-mapped.test.ts` "a mapping file says how to list, read and update..." -> `mapped-tracker-a-mapping-without-an-update-call-is-accepted.json`.
  - `factory tools` probes and reports working calls -> "factory tools probe" (3 tests, including the real command and exit 4) -> `factory-tools-the-tools-command-is-not-dispatched.json`, `factory-tools-the-update-call-is-always-run-even-without-write.json`.
  - Examples for three trackers -> "ships examples for three trackers, each valid" -> `mapped-tracker-the-shipped-linear-example-loses-its-read-call.json`.
  - Fake MCP server drives list, read, update -> "the generic tracker over a fake MCP server" (5 tests) -> `mapped-tracker-a-closed-issue-is-listed-as-open-work.json`, `...adding-a-label-does-not-reach-the-server.json`, `...the-answer-is-read-from-the-whole-body-not-the-items-path.json`, `...maketracker-does-not-know-the-mapped-kind.json`.
- #598: done.
  - A mapping can name a declared CLI tool -> `tests/tracker-mapped-cli.test.ts` "a mapping that names a declared CLI tool" and "a mapping naming a tool the repo did not declare is refused with that name" -> `mapped-cli-a-mapping-naming-a-cli-tool-still-talks-to-an-mcp-server.json`.
  - Fake CLI drives list, read, update -> "the generic tracker over a fake CLI" (5 tests) -> `mapped-cli-a-label-list-is-passed-with-the-wrong-separator.json`, `...a-failing-command-is-read-as-an-answer.json`, `...argv-templates-are-passed-unfilled.json`.
## Staged workflow changes
none
## Checkpoints
All three issues: 1 yes (outside-area files are listed below), 2 yes, 3 yes, 4 yes (each mutation was seen to bite; the first run of two mutations showed "still passes", the tests were tightened until they bit), 5 one deviation, reported: `quality-baseline/lines/src__config.ts.json` raised 787 -> 794 because `TrackerConfig` gained a `mapped` kind (`--allow-raise`); `cli.ts` stays at 911 lines, 2 comment lines were joined to pay for the new dispatch line, 6 yes (config, integrations, scm, help, registry neighbours run), 7 yes.
## Files outside my area
- `src/config.ts`: new `mapped` tracker kind, `tokenEnv` not required for it.
- `src/cli.ts`: dispatch for `tools` (line count unchanged).
- `src/help.ts`, `docs/cli-reference.md`: the `tools` command.
- `src/engine/registry.ts`: registers `cli`.
- `src/scm.ts`: tracker switch replaced by registry lookup (asked for in the brief).
- `tests/config.test.ts`, `tests/integrations.test.ts`: pins on the tracker kind list and the old switch.
- `tests/mutations.json`: re-anchored "scm: makeTracker builds each native kind" on the registry line.
- `integrations/mapped/manifest.json`, `docs/integrations.md` (generated): every tracker kind needs a manifest.
- `quality-baseline/lines/src__config.ts.json`: see checkpoint 5.
## Gate evidence
make fast: ok
## Risk and rollback
Low. New kinds and steps are opt-in. The one behaviour change is that `makeTracker` looks the tracker up in the registry, covered by the existing config test and a re-anchored mutation. The example mappings use tool names that are starting points for each vendor's MCP server, not verified against the live servers; `factory tools` is how a user checks them. A mapped tracker's issues carry no comments and `roleOf` is "none", so label trust there is not established. Roll back by reverting the four commits.
## Learnings
- `src/cli.ts` is at its exact line cap and the baseline test requires equality; a new command had to be paid for by trimming a comment. The factory should give commands a dispatch table outside `cli.ts`.
- `tests/integrations.test.ts` read the `case` labels inside `makeTracker`'s source, so any registry refactor of `src/scm.ts` breaks it; it now reads the registry.
- `bun scripts/gen-quality-baseline.ts --allow-raise` is the way to move a line baseline; `make fast` fails with only the drift message.
- `tests/mutations.json` still holds legacy entries anchored on source lines; `check-mutations` runs them from `make fast`, so a refactor of an anchored line fails there, not in unit tests.
- `scripts/check-mutations.ts` prints "still passes ... guards nothing" only on its last line; use `| tail -2`.
- `mutationSlug` truncates and strips punctuation, so write mutation files with `shardPath` from `scripts/mutation-list.ts` rather than by hand.
- Not done, left out on purpose: docs for the `cli` step in `docs/workflows.md` and a mapping guide (outside the area).
