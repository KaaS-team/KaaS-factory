<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E7 Plugins and API
Milestone: Phase 2 modular core
Runner: operator

## Risk: low

## Why
The CLI reference drifts from the commands, so agents and people read stale flags. Issue #390.

## Today
- `src/help.ts` and `src/cli.ts` hold the command help. `scripts/gen-agents-doc.ts` and `scripts/gen-integrations-doc.ts` already generate docs with a check mode; copy that pattern (read one first) instead of inventing a new one.

## Change
### T1: generate the reference
Files: `scripts/gen-cli-reference.ts`, `tests/gen-cli-reference.test.ts`, `docs/cli-reference.md`
Model: sonnet
1. `scripts/gen-cli-reference.ts` exports `render()` returning the Markdown reference built from the same help data the CLI prints (find it in `src/help.ts`; do not re-type flags). With `--write` it writes `docs/cli-reference.md`; with `--check` it exits 1 and prints a diff hint when the committed file differs from a fresh render.
2. Tests: `render()` mentions every command name the help lists; `--check` exits 1 on a temp copy that was edited and 0 on a fresh one.
3. Commit the generated `docs/cli-reference.md`.

### T2: one-read agent guide
Files: `src/help.ts`, `tests/cli-skill.test.ts`
Model: sonnet
Deps: T1
1. `factory --skill` prints the agent-facing guide: the command list with one line each and the flags, on one screen of plain text, from the same data as T1.
2. Test: the output names every command and exits 0.

### T3: wire the check
Files: `Makefile`, `tests/ci-wiring.test.ts`
Model: haiku
Deps: T1
1. Add a `check-cli-reference` target running `bun scripts/gen-cli-reference.ts --check`, add it to the prerequisites of `check`, and extend `tests/ci-wiring.test.ts` with one assertion that `check` lists it. Add the name to `.PHONY` in the same style as its neighbours.

## Tests
- `tests/gen-cli-reference.test.ts`: [permanent] render and check cases.
- `tests/cli-skill.test.ts`: [permanent] the guide lists every command.

## Mutation
```json
{"name":"cli-reference: check passes on drift","file":"scripts/gen-cli-reference.ts","find":"process.exit(1)","replace":"process.exit(0)","test":"tests/gen-cli-reference.test.ts"}
```
Adjust `find` to text that occurs exactly once in the file as you wrote it.

## Acceptance
- AC-1: an edited reference fails the check: checked by `make test FILES=tests/gen-cli-reference.test.ts` (T1)
- AC-2: `--skill` names every command: checked by `make test FILES=tests/cli-skill.test.ts` (T2)
- AC-3: `check` lists `check-cli-reference`: checked by `make test FILES=tests/ci-wiring.test.ts` (T3)

## Non-goals
Do not touch .github/workflows (stage workflow edits under ci/). No new dependencies. No em dashes, no filler words. Nothing outside Files.

## Files
- `scripts/gen-cli-reference.ts`
- `tests/gen-cli-reference.test.ts`
- `docs/cli-reference.md`
- `src/help.ts`
- `tests/cli-skill.test.ts`
- `Makefile`
- `tests/ci-wiring.test.ts`

## How to ship
One PR from branch feat/s-cli-reference. Commits use `git commit -s`. Fill every section of .github/pull_request_template.md with real evidence. Run `python3.12 scripts/kaas/check-affected.py --run` before pushing. Each new mutation entry is {name,file,find,replace,test}; its `find` matches exactly once and the test must fail under the replacement. Put new mutations in a shard file `tests/mutations/s-cli-reference.json`, never in tests/mutations.json. Never put a session link in a commit or PR.
