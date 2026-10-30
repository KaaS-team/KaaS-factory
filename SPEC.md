<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E1 Team model
Milestone: Phase 2 modular core
Runner: operator

## Why
E1a (#283, merged as a4b18bd) built the team core in `src/team/` but nothing calls it, so an org and team file still change nothing at run time. E1b wires that core into `loadConfig`, stamps a config hash on every run row and stage row so two runs can say they used the same config, adds `factory explain <N>` so an operator sees which level set each key, and adds a CI check that lists open issues no epic references. A repo with no `.factory/team/` directory loads exactly today's config.

## Today
- `src/config.ts` (770 lines): `loadConfig` starts at `:689`, sets `let config = mergeConfig(raw as Partial<FactoryConfig>);` at `:698`, refuses a repo/origin mismatch at `:715`, checks route skills from `:720`, and ends with `return config;` at `:732`. `mergeConfig` (`:326`) is the one resolver for defaults; `configProblems` (`:423`) validates raw config; `ConfigError` is at `:687`.
- `src/team/load.ts` exports `loadOrg(dir)` and `loadTeams(dir)` returning `Loaded<T>` (`{ ok: true, value } | { ok: false, problems }`); a missing `org.yml` yields `{ name: "org" }`.
- `src/team/resolve.ts` exports `resolveTeam(input: ResolveInput): Resolved` with `values`, `origin` (dotted key to `builtin`, `org`, `team` or `repo`) and `problems`. Preferences are `model`, `workflow`, `labels`, `timeouts`; named sets are `roles`, `workflows`, `routes`.
- `src/team/hash.ts` exports `configHash(values: unknown): string` (12 hex chars).
- `src/team/schema.ts` exports `PolicySpec`, `RISKS` and `Risk`; `TeamFile.repos?: string[]` exists and nothing reads it yet.
- Run storage is SQLite in `src/state.ts` (732 lines): table `runs` (CREATE at `:158`, `status_comment_id INTEGER,` at `:174`), table `stage_runs` (`:186`). There is no audit table: the per stage record is `stage_runs`. Migrations are the forward-only `ALTER TABLE stage_runs ADD COLUMN` loop at `:256` to `:273`; `makeCostNullable` (`:280`) rebuilds `stage_runs` from a fixed column list ending `verdict TEXT, tokens_cache_write INTEGER NOT NULL DEFAULT 0` (`:305`), so a new `stage_runs` column must be added there too.
- Writers: `FactoryState.upsertRun` (`src/state.ts:320`) and `recordStageRun` (`:433`). Callers in src: `src/engine/common.ts:337` (`upsertRun`), `:371` and `:476` (`recordStageRun`), `src/engine/minion.ts:216` (`recordStageRun`). Tests call them 67 times, so the new field must be optional on input.
- `type DefaultedStageRunKey` (`src/state.ts:105`) lists the `StageRunInput` keys that are optional on insert.
- CLI: `src/cli.ts` dispatches in `main()`; `case "doctor":` is at `:937`; `cli` (`:81`) is a `CliContext` (`src/cli-runtime.ts:16`), and `case "install":` shows the lazy pattern `return (await import("./init-cli")).cmdInstall(cli);`. `src/help.ts` `COMMANDS` holds the `doctor` entry at `:96`; `tests/help.test.ts` fails when a `case` has no `COMMANDS` entry.
- `issueType(routes, labelNames)` is in `src/labels.ts:201`; `makeScm(config).getIssue(repo, n)` fetches one issue (`src/scm.ts:71`).
- Epics: `parseMeta(body).epic` (`src/core/schedule.ts:17`) reads an `Epic:` preface line; `childIssues(body, self)` (`src/engine/epic.ts:34`) lists the issue numbers in a checklist.
- `.github/workflows/ci.yml` job `push` sets `permissions: contents: read, actions: read` (no `issues`), runs `bun scripts/check-pr-body.ts` as a step at `:36`, and `make install` at `:48`.
- `quality-baseline.json` freezes `lines` for `src/cli.ts` 985, `src/config.ts` 770, `src/state.ts` 732, `src/engine/common.ts` 642; `tests/quality.test.ts` requires each baseline to equal the file's size. New files must stay under 400 lines with comment runs of 3 lines or fewer.

## Change
### T1: team files in loadConfig
Files: `src/team/apply.ts`, `src/config.ts`, `tests/team-wiring.test.ts`, `tests/fixtures/team-repo/.factory/config.json`, `tests/fixtures/team-repo/.factory/team/org.yml`, `tests/fixtures/team-repo/.factory/team/teams/core.yml`, `tests/fixtures/team-repo/.factory/team/teams/site.yml`, `tests/mutations.json`, `quality-baseline.json`
Model: sonnet
1. Discovery rule: a repo opts in by having the directory `<repo>/.factory/team/` (holding `org.yml` and `teams/*.yml`). Its team is the one team file whose `repos` list names `config.repo` (compared lower case). No match means org only. Two matches is a problem. No directory means no change. No new config.json key is added.
2. Create `src/team/apply.ts`. Imports: `existsSync` from `node:fs`, `join` from `node:path`, `import type { FactoryConfig, RouteConfig } from "../config";` (type only, so no runtime import cycle), `loadOrg, loadTeams` from `./load`, `type Resolved, resolveTeam` from `./resolve`, `type PolicySpec, type Risk, RISKS` from `./schema`.
3. Export `interface TeamApplied { config: FactoryConfig; resolved: Resolved; team?: string; problems: string[] }` and `interface ApplyInput { repoDir: string; config: FactoryConfig; defaults: FactoryConfig; raw: Record<string, unknown>; check: (raw: unknown) => string[] }`.
4. Add `const KEYS = ["workflow", "labels", "routes"] as const;` and `const view = (c: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));`.
5. Export `function applyTeam(input: ApplyInput): TeamApplied`. Let `dir = join(input.repoDir, ".factory", "team")` and `base = { builtin: view(input.defaults as unknown as Record<string, unknown>), repo: view(input.raw) }`. If `!existsSync(dir)` return `{ config: input.config, resolved: resolveTeam(base), problems: [] }`, returning the same `config` object unchanged.
6. Otherwise call `loadOrg(dir)` and `loadTeams(dir)`; if either is not ok, return `{ config: input.config, resolved: resolveTeam(base), problems: [...org problems, ...teams problems] }`. Filter `teams.value` to those whose `repos` contains `input.config.repo` (lower case compare); if more than one, return a problem `teams ${names joined with " and "} both list ${repo} in repos; a repo belongs to one team.`.
7. Call `const resolved = resolveTeam({ ...base, org: org.value, team })` and `const p = (resolved.values.policy ?? {}) as PolicySpec;`. Build the next config from the input config: `workflow` from `resolved.values.workflow as string`, `labels` from `resolved.values.labels as Record<string, string>`, `routes` from `resolved.values.routes as Record<string, RouteConfig>`.
8. Policy is applied as a clamp only, never a loosening. Write the merge line exactly as: `const merge = p.auto_merge?.allowed === false && config.merge.policy === "auto" ? { ...config.merge, policy: "dry-run" as const } : config.merge;` (where `config` is `input.config`). Risk: `const rank = (r: string | undefined) => (r === undefined ? RISKS.length : RISKS.indexOf(r as Risk));`, `const cap = Math.min(rank(p.risk_max), rank(p.auto_merge?.max_risk));`, and set `riskPolicy.autoApproveMaxRisk` to `RISKS[cap]` only when `cap < rank(config.riskPolicy.autoApproveMaxRisk)`. `protectedPaths` becomes `[...new Set([...config.protectedPaths, ...(p.protected_paths ?? [])])]`. `models`, `budget_usd_month`, `approvals` and `roles` are resolved and shown by explain but not applied (NG-1).
9. Return `{ config: next, resolved, team: team?.name, problems: input.check({ ...input.raw, workflow: next.workflow, labels: next.labels, routes: next.routes }) }`, so a team route is validated by the same `configProblems` as a repo route.
10. In `src/config.ts` add `import { applyTeam, type TeamApplied } from "./team/apply";` after the import at `:13`. Replace the signature line `export async function loadConfig(targetRepoDir: string): Promise<FactoryConfig> {` (`:689`) with a two line `loadConfig` that returns `(await loadConfigExplained(targetRepoDir)).config;`, a one line comment `// loadConfig plus the team resolution behind it, for \`factory explain\`.`, and `export async function loadConfigExplained(targetRepoDir: string): Promise<TeamApplied> {` keeping the old body.
11. In that body, directly before the comment `// configProblems is pure and cannot see the worktree, so a route naming a` (`:720`), insert: `const team = applyTeam({ repoDir: targetRepoDir, config, defaults: mergeConfig({ profile: config.profile }), raw: raw as Record<string, unknown>, check: configProblems });`, then `if (team.problems.length > 0) throw new ConfigError(\`${targetRepoDir}/.factory/team does not fit ${path}:\n  - ${team.problems.join("\n  - ")}\`);`, then `config = team.config;`. Replace the final `return config;` (`:732`) with `return { ...team, config };`. The skills check stays after the insert, so a team route's skills are checked too.
12. Fixture `tests/fixtures/team-repo/.factory/config.json`: `{ "repo": "acme/core-api", "merge": { "policy": "auto" }, "riskPolicy": { "autoApproveLowRisk": true, "autoApproveMaxRisk": "medium" }, "labels": { "factory:ready": "ready-for-ai" } }`. `org.yml`: `name: acme`, `locked: [review]`, `policy: { risk_max: low, auto_merge: { allowed: false }, protected_paths: ["infra/**"], extend: true }`. `teams/core.yml`: `name: core`, `repos: [acme/core-api]`, `workflow: docs-to-pr`, `routes: { docs: { proof: check } }`, `roles: { review: { model: opus } }`, `policy: { protected_paths: ["db/**"] }`. `teams/site.yml`: `name: site`, `repos: [acme/site]`, `workflow: feature-to-pr`.
13. `tests/team-wiring.test.ts`: copy a fixture into a `mkdtempSync` dir (no `.git`, so no origin lookup) and call `loadConfigExplained`. Cases: (a) for each of `.factory/config.json`, `template/.factory/config.example.json` and `tests/fixtures/monorepo/.factory/config.json`, `loadConfig(dir)` deep equals `mergeConfig(raw)` and `applyTeam` with no team dir returns the same object (`toBe`); (b) the team-repo fixture resolves `workflow` `docs-to-pr`, `routes.docs.proof` `check`, keeps the repo label, `merge.policy` `dry-run`, `riskPolicy.autoApproveMaxRisk` `low`, `protectedPaths` containing `infra/**` and `db/**`, `team` `core`, and a `resolved.problems` entry naming `roles.review`; (c) a second team file that also lists `acme/core-api` makes `loadConfig` throw `ConfigError` naming both teams; (d) a team route with `proof: maybe` makes `loadConfig` throw.
14. Add the T1 entry from Mutation to `tests/mutations.json`. Set the `lines` value for `src/config.ts` in `quality-baseline.json` to the file's new size; keep the growth to the lines above.

### T2: config hash on run and stage rows
Files: `src/state.ts`, `src/engine/common.ts`, `src/engine/minion.ts`, `tests/config-hash-stamp.test.ts`, `tests/mutations.json`, `quality-baseline.json`
Model: sonnet
1. In `src/state.ts` add `config_hash: string | null;` to `interface Run` after `status_comment_id: number | null;` (`:62`) and to `interface StageRun` after `verdict: string | null;` (`:101`), each with a one line comment `// configHash of the FactoryConfig the stage ran with; NULL for rows written before it existed.` on the first.
2. Add `| "config_hash"` to `type DefaultedStageRunKey` (`:105`) so `StageRunInput` takes it as optional.
3. Replace the migration block from `const have = new Set(` (`:257`) to the end of its `for` loop (`:273`) with one loop over `[table, col, ddl]` triples: the five existing `stage_runs` columns unchanged, then `["stage_runs", "config_hash", "TEXT"],` and `["runs", "config_hash", "TEXT"],` on their own lines. Inside the loop read `PRAGMA table_info(${table})` and skip when the column exists; keep the `duplicate column` catch. Keep the comment `// Forward-only and idempotent: safe to run on boot from several replicas.`.
4. In `makeCostNullable` change `verdict TEXT, tokens_cache_write INTEGER NOT NULL DEFAULT 0` (`:305`) to `verdict TEXT, tokens_cache_write INTEGER NOT NULL DEFAULT 0, config_hash TEXT`, so the rebuild copies the new column.
5. `upsertRun` (`:320`): add `config_hash?: string` to the input type; add `config_hash` to the INSERT column list, `$config_hash` to VALUES, `config_hash = excluded.config_hash,` to the DO UPDATE SET list, and `$config_hash: input.config_hash ?? null,` to the bound params.
6. `recordStageRun` (`:433`): add `config_hash` to the column list and `$config_hash` to VALUES, and `$config_hash: input.config_hash ?? null,` after `$session_id: input.session_id ?? null,` (`:457`).
7. In `src/engine/common.ts` add `import { configHash } from "../team/hash";` with the other imports and add `config_hash: configHash(config),` as the last field of the `upsertRun({` object (`:337`) and of both `recordStageRun({` objects (`:371`, `:476`). In `src/engine/minion.ts` add the same import and the same field to `recordStageRun({` (`:216`).
8. `tests/config-hash-stamp.test.ts`: (a) structural: read every `src/**/*.ts` except `src/state.ts`, find each `.upsertRun({` and `.recordStageRun({`, take the text up to its matching `});`, and fail naming file and line when it lacks `config_hash:`; assert at least 4 call sites were found. (b) `new FactoryState(":memory:")`: `upsertRun({ ..., config_hash: "abc123def456" })` then `getRun(...).config_hash` is that value; `recordStageRun` with a `config_hash` then `listStageRuns(repo)[0].config_hash` is that value; without one it is `null`. (c) an old database: create a file DB with `bun:sqlite` holding `runs` and `stage_runs` in their pre change shape (copy the CREATE statements from `src/state.ts`, with `stage_runs.cost_usd REAL NOT NULL DEFAULT 0` so `makeCostNullable` runs), insert one row each, open it with `new FactoryState(path)` twice, and assert both tables have a `config_hash` column and the rows survive.
9. Add the T2 entry from Mutation to `tests/mutations.json`. Set the `lines` values for `src/state.ts` and `src/engine/common.ts` in `quality-baseline.json` to the new sizes.

### T3: factory explain
Files: `src/team/explain.ts`, `src/explain-cli.ts`, `src/cli.ts`, `src/help.ts`, `README.md`, `tests/team-explain.test.ts`, `tests/mutations.json`, `quality-baseline.json`
Model: sonnet
Deps: T1
1. `src/team/explain.ts` exports `explainLines(input: { issue: number; repo: string; type?: string; applied: TeamApplied }): string[]` and imports only `configHash` from `./hash` and `type TeamApplied` from `./apply`. Add a local `valueAt(values: Record<string, unknown>, key: string): unknown` that walks the dotted key.
2. The first line is `` `#${input.issue} on ${input.repo}: team ${applied.team ?? "none"}, type ${input.type ?? "none"}` ``, the second `` `config_hash ${configHash(applied.config)}` ``. Then one line per key of `applied.resolved.origin` sorted, written exactly as: `const line = \`${key} = ${JSON.stringify(valueAt(applied.resolved.values, key))} (${applied.resolved.origin[key]})\`;` and pushed with the suffix ` [this issue]` when `input.type` is set and `key` starts with `` `routes.${input.type}.` ``. Then one `` `problem: ${p}` `` line per `applied.resolved.problems` entry.
3. `src/explain-cli.ts` exports `async function cmdExplain(cli: CliContext): Promise<void>`: `const n = Number(cli.args[1]);` and throw `new UsageError("explain: usage: factory explain <N> (--repo-dir <path> | --repo <owner/name>)")` when it is not a positive integer; `const applied = await loadConfigExplained(await cli.resolveCloneDir());`; `const issue = await makeScm(applied.config).getIssue(applied.config.repo, n);`; `const type = issueType(applied.config.routes, issue.labels.map((l) => l.name));`; print each `explainLines` line with `console.log`. Imports: `CliContext` (type) from `./cli-runtime`, `UsageError` from `./cli-output`, `loadConfigExplained` from `./config`, `makeScm` from `./scm`, `issueType` from `./labels`, `explainLines` from `./team/explain`.
4. In `src/cli.ts` add after `return cmdDoctor();` (`:938`) the two lines `    case "explain":` and `      return (await import("./explain-cli")).cmdExplain(cli);`.
5. In `src/help.ts` add after the `doctor` entry (`:95` to `:99`): `{ name: "explain", usage: "explain <N> (--repo-dir <path> | --repo <owner/name>)", does: "print each config key for #N, its value and the level that set it (builtin, org, team or repo), the config hash and any team problems" }`. In `README.md` add a matching table row after the `factory doctor` row (`:379`).
6. `tests/team-explain.test.ts` (no network): copy `tests/fixtures/team-repo` to a temp dir, call `loadConfigExplained`, then `explainLines({ issue: 7, repo: "acme/core-api", type: "docs", applied })`. Assert it contains `workflow = "docs-to-pr" (team)`, `labels.factory:ready = "ready-for-ai" (repo)`, `policy.auto_merge.allowed = false (org)`, `` `config_hash ${configHash(applied.config)}` `` equal to `configHash(await loadConfig(dir))`, a line starting `routes.docs.proof` ending `[this issue]`, and a `problem:` line naming `roles.review`. A second case on `tests/fixtures/monorepo` asserts every key line ends `(builtin)` or `(repo)` and the header says `team none`.
7. Run `bun test tests/help.test.ts`. Add the T3 entry from Mutation to `tests/mutations.json`. Set the `lines` value for `src/cli.ts` in `quality-baseline.json` to the new size.

### T4: epic coverage check
Files: `scripts/epic-coverage.ts`, `tests/epic-coverage.test.ts`, `tests/fixtures/epic-coverage/issues.json`, `.github/workflows/ci.yml`, `tests/mutations.json`
Model: sonnet
1. `scripts/epic-coverage.ts` opens with a 2 line comment saying what it lists and how it runs. It imports `readFileSync` from `node:fs`, `parseMeta` from `../src/core/schedule` and `childIssues` from `../src/engine/epic`, and exports `interface OpenIssue { number: number; title: string; body: string }`.
2. Export `function uncovered(issues: readonly OpenIssue[]): OpenIssue[]`: an issue is covered when its preface has an `Epic:` line (`parseMeta(body).epic`), when it is an epic itself (`childIssues(body, number).length > 0`), or when any issue's checklist names it. Build `const named = new Set(issues.flatMap((i) => childIssues(i.body ?? "", i.number)));` and write the filter exactly as: `return issues.filter((i) => !named.has(i.number) && !parseMeta(i.body ?? "").epic && childIssues(i.body ?? "", i.number).length === 0);`.
3. Under `if (import.meta.main)`: read the JSON file named by `process.argv[2]` (the output of `gh issue list --state open --json number,title,body`); with no argument print a usage line to stderr and exit 2; print `#<n> <title>: no epic references it` to stderr per uncovered issue and exit 1 when any, else print `epic-coverage: ok`. The script never calls `gh` itself, so it runs offline on a file.
4. Fixture `tests/fixtures/epic-coverage/issues.json`: #10 an epic whose body is `- [x] #11\n- [ ] #12`; #11 with `Epic: E1 Team model` in its preface; #12 with a plain body (covered only by #10's checklist); #13 `Fix the footer.`; #14 an empty body.
5. `tests/epic-coverage.test.ts`: `uncovered` on the fixture returns exactly #13 and #14; running `bun scripts/epic-coverage.ts <fixture>` exits 1 and names #13; a file with only #10, #11 and #12 exits 0; `.github/workflows/ci.yml` contains `bun scripts/epic-coverage.ts`, so the wiring cannot be dropped silently.
6. In `.github/workflows/ci.yml` job `push`: add `issues: read` under `permissions` after `actions: read` (`:21`), and after the `make install` step (`:48`, `:49`) add a step `- name: Every open issue belongs to an epic (scripts/epic-coverage.ts)` with `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `run: gh issue list --repo "${{ github.repository }}" --state open --limit 1000 --json number,title,body > "$RUNNER_TEMP/issues.json" && bun scripts/epic-coverage.ts "$RUNNER_TEMP/issues.json"`.
7. Add the T4 entry from Mutation to `tests/mutations.json`.

## Tests
- `tests/team-wiring.test.ts`: [permanent] every existing config fixture loads to `mergeConfig(raw)` with no team dir; the team-repo fixture applies workflow, route, label, merge clamp, risk clamp and protected paths; two teams claiming one repo and a bad team route are refused.
- `tests/config-hash-stamp.test.ts`: [permanent] every `upsertRun` and `recordStageRun` call in src passes `config_hash`; both tables store it; an old database, including one that needs the cost rebuild, gains the column and keeps its rows.
- `tests/team-explain.test.ts`: [permanent] explain names the level for team, repo and org keys, prints the same hash the runner stamps, marks the issue's route and lists the locked role problem; a repo with no team shows only builtin and repo.
- `tests/epic-coverage.test.ts`: [permanent] the fixture yields exactly the two orphan issues; the script's exit codes; ci.yml runs it.
- `tests/help.test.ts`: [permanent] existing test; it now covers `explain`.

## Mutation
```json
{"name":"team apply: org auto_merge false ignored","file":"src/team/apply.ts","find":"p.auto_merge?.allowed === false && config.merge.policy === \"auto\"","replace":"false","test":"tests/team-wiring.test.ts"}
```
```json
{"name":"config hash: runs column never added","file":"src/state.ts","find":"[\"runs\", \"config_hash\", \"TEXT\"],","replace":"","test":"tests/config-hash-stamp.test.ts"}
```
```json
{"name":"explain: origin always builtin","file":"src/team/explain.ts","find":"(${applied.resolved.origin[key]})","replace":"(builtin)","test":"tests/team-explain.test.ts"}
```
```json
{"name":"epic coverage: checklist children not counted","file":"scripts/epic-coverage.ts","find":"!named.has(i.number) && ","replace":"","test":"tests/epic-coverage.test.ts"}
```

## Acceptance
- AC-1: a repo with no `.factory/team/` loads exactly today's config, and a team file applies through `loadConfig` without loosening the org: checked by `tests/team-wiring.test.ts` (T1)
- AC-2: every run row and stage row carries the config hash, and old databases migrate: checked by `tests/config-hash-stamp.test.ts` (T2)
- AC-3: `factory explain <N>` prints each key, its value, its level, the hash and the problems, and help lists it: checked by `tests/team-explain.test.ts` and `tests/help.test.ts` (T3)
- AC-4: open issues no epic references are listed and CI runs the check: checked by `tests/epic-coverage.test.ts` (T4)

## Non-goals
- NG-1: `policy.models`, `policy.budget_usd_month`, `policy.approvals`, `roles` and `source` are resolved and shown by explain but not enforced on a run; enforcement is a later E-series issue.
- NG-2: the plane mirror (`src/blobs.ts` `RUN_COLS`, `STAGE_COLS`, `UPSERT_RUN`, `INSERT_STAGE`) does not carry `config_hash` yet; a mirrored run shows NULL.
- NG-3: no `team` key in `.factory/config.json`; the team is found by its `repos` list.
- NG-4: no `--json` output for explain; no dashboard column for the hash.
- NG-5: no new dependency.

## Risk: medium

## Files
- `src/team/apply.ts` (new)
- `src/team/explain.ts` (new)
- `src/explain-cli.ts` (new)
- `scripts/epic-coverage.ts` (new)
- `tests/team-wiring.test.ts` (new)
- `tests/config-hash-stamp.test.ts` (new)
- `tests/team-explain.test.ts` (new)
- `tests/epic-coverage.test.ts` (new)
- `tests/fixtures/team-repo/.factory/config.json` (new)
- `tests/fixtures/team-repo/.factory/team/org.yml` (new)
- `tests/fixtures/team-repo/.factory/team/teams/core.yml` (new)
- `tests/fixtures/team-repo/.factory/team/teams/site.yml` (new)
- `tests/fixtures/epic-coverage/issues.json` (new)
- `src/config.ts` (edit: `loadConfigExplained`, team apply before the skills check)
- `src/state.ts` (edit: `config_hash` columns, migration loop, rebuild list, both writers)
- `src/engine/common.ts` (edit: stamp three call sites)
- `src/engine/minion.ts` (edit: stamp one call site)
- `src/cli.ts` (edit: `case "explain"`)
- `src/help.ts` (edit: `explain` entry)
- `README.md` (edit: command table row)
- `.github/workflows/ci.yml` (edit: `issues: read`, epic coverage step)
- `tests/mutations.json` (edit: add the four entries)
- `quality-baseline.json` (edit: new `lines` for `src/config.ts`, `src/state.ts`, `src/engine/common.ts`, `src/cli.ts`)
