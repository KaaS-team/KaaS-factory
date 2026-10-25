# software-factory

A GitHub-native loop for coding agents: triage, plan, build, verify, PR. `src/` is the runner,
`bin/factory` the CLI (its code is `src/cli.ts`), `dashboard/` the web view. `install.sh` copies `template/` into a target repo;
`template-ci/` holds the inert CI workflow. Reasoning goes in `docs/decisions/`.

## Commands

- `make check`: typecheck, `bun test`, then `skills-ref validate` on every template skill. It needs
  `uvx` and fails without it. This is the gate.
- `make check-mutations`: applies each entry in `tests/mutations.json` to a copy of the repo, and its
  test must go red. A new check lands with its mutation in the same change. It runs in `mutations.yml`, off the push verdict: on a pull request, a push that changes a
  test or a check, and nightly.
- `make agent-matrix` spends tokens on real agents, so it is never part of the gate.

## Things that change together

- **Claude argv.** `src/agents/presets/claude.ts` is pinned byte for byte by `tests/agents.test.ts`.
  Check a new flag against `claude --help` first.
- **Stage artifacts.** `stageSchema` in `src/schemas.ts` is the one source of truth.
  - `src/artifacts.ts` validates against it (`tests/schemas.test.ts`).
  - `template/.claude/hooks/stop-artifact.sh` checks against it, through the schema file the runner
    writes (`tests/stop-artifact.test.ts`).
  - Of the field names a stage skill lists, tests check only `outcome`. Edit the skill in the same change.
- **Stage shell rules.** `STAGE_GUIDANCE` and the allow-lists live in `src/stage-permissions.ts`.
  Template agents carry `STAGE_GUIDANCE` verbatim (`tests/skills.test.ts`), and every git, bash,
  gates.sh or mutate.sh command in a stage skill must be on its allow-list (`tests/stage-permissions.test.ts`).
- **Presets.** `docs/agents.md`'s table is generated from `PRESETS` by `scripts/gen-agents-doc.ts`,
  and `tests/agents-registry.test.ts` fails when they differ.
- **Version.** `package.json` and `template-ci/factory.yml.example`'s `FACTORY_RUNNER_REF` move
  together (`tests/release.test.ts`).

## The template

`template/` ships to other people's repos, so it depends on nothing on this machine: no plugin, and no
`~/.claude` or `/Users/` path. `.claude/rules/template.md` loads when you edit it.
