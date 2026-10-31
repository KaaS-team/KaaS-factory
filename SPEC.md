<!-- factory:planned v1 -->
Blocked by: #210
Deps: #210, #196
Epic: E9.2 Docs and org tests
Milestone: Phase 9 brand
Runner: factory

## Why
A buyer, an agent and an SDK user each need a stable page to read, and each repo in the org must carry the same brand without anyone checking by hand. Today the docs are twelve loose files under `docs/` with no index, there is no `llms.txt` for agents, the protocol and SDK packages (from #196) have no written versioning promise and no test that a release keeps it, and nothing checks that every public repo points at kaas.team. This epic adds B4 (docs index plus a generated `llms.txt`), B5 (versioning policy plus a compat test) and B6 (an org structural test over the repo table from #210).

## Today
- `docs/` holds `agents.md`, `control-plane.md`, `events.md`, `integrations.md`, `receipts.md`, `runtimes.md`, `self-host.md`, `tracker-api.md`, `trackers.md`, `verify-an-agent.md` and `workflows.md`, plus `decisions/`; there is no `docs/index.md` and no `llms.txt` anywhere.
- `scripts/gen-agents-doc.ts` and `scripts/gen-integrations-doc.ts` already generate docs from code and `tests/agents-registry.test.ts` fails when the output drifts; `llms.txt` follows the same pattern.
- `src/docs-links.ts:12` `repositoryFiles(suffix, root)` walks Markdown files and checks local links; the docs index reuses it to list pages.
- #196 publishes `packages/protocol` (the `ROUTES` table from #195's `src/api/routes.ts`) and `packages/sdk`; neither has a compat snapshot. `tests/release.test.ts` pins `package.json` version to `template-ci/factory.yml.example`.
- `scripts/goals.ts:16` a `ProbeProof` is `{ probe }`, a shell script under `scripts/probes/`; the weak-probe guard refuses `--help`, `|| true` and echo-only probes.
- #210 adds `docs/brand/repos.md`, the one table of public repos and their homepage.

## Change
### T1: docs index and generated llms.txt (B4)
Files: `docs/index.md`, `scripts/gen-llms.ts`, `llms.txt`, `tests/llms.test.ts`, `Makefile`
Model: haiku
1. `docs/index.md`: one line per page in `docs/` saying who it is for (operator, SDK user, agent), grouped Start, Run, Extend, Reference. No prices, no model names.
2. `scripts/gen-llms.ts` writes `llms.txt` at the repo root in the llmstxt.org shape: `# KaaS Factory`, a one-line summary, then `## Docs` with one `- [title](https://factory.kaas.team/docs/<page>): <first sentence>` per page from `repositoryFiles(".md", "docs")`, skipping `decisions/` and `research/`.
3. `tests/llms.test.ts` regenerates in memory and fails when the committed `llms.txt` differs, naming the page; it also fails when a docs page is missing from `docs/index.md`.
4. Add `make docs` that runs both generators; the test is part of `bun test` so `make check` covers it.

### T2: versioning policy and protocol compat test (B5)
Files: `docs/versioning.md`, `packages/protocol/compat/v1.json`, `scripts/protocol-snapshot.ts`, `tests/protocol-compat.test.ts`
Model: sonnet
1. `docs/versioning.md`: protocol and SDK follow semver separately from the runner; removing a route, removing or renaming a response field, or making an optional request field required is a major change; adding a route or an optional field is minor. Each `packages/*/package.json` carries its own version.
2. `scripts/protocol-snapshot.ts` writes `packages/protocol/compat/v1.json`: per route id, its method, path, required request fields and response field names, sorted.
3. `tests/protocol-compat.test.ts` compares the live `ROUTES` with the snapshot. Under the same major, a route or field present in the snapshot and missing now fails with its route id; additions pass. The rule must be written as exactly this line: `const breaking = [...was].filter((k) => !now.has(k));`
4. A major bump in `packages/protocol/package.json` writes a new `v<major>.json` and the test reads the snapshot for the current major.

### T3: org structural test (B6)
Files: `scripts/org-check.ts`, `scripts/probes/org-brand.sh`, `tests/org-check.test.ts`, `goals.json`
Model: sonnet
1. `scripts/org-check.ts` exports `orgProblems(rows, fetchRepo)`: for every row in `docs/brand/repos.md` it checks the repo's GitHub homepage is `https://kaas.team`, its README holds `## Built by KaaS`, and, when the repo has factory PRs (head branch `factory/`), the latest merged one ends with the footer from `DEFAULT_FOOTER`. `fetchRepo` is injected so the test runs offline.
2. A repo missing from GitHub, or a public repo missing from the table, is a problem by name. The homepage check must be written as exactly this line: `if (repo.homepage !== "https://kaas.team") out.push(\`${row.name}: homepage is ${repo.homepage || "empty"}\`);`
3. `scripts/probes/org-brand.sh` runs `bun scripts/org-check.ts` with `gh api` as the fetcher and exits non-zero on any problem; it calls the real API, so it passes the weak-probe guard.
4. Add goal rows `org-brand` (probe) and `protocol-compat` (test proof) to `goals.json` in phase P9.

## Tests
- `tests/llms.test.ts`: [permanent] the committed llms.txt matches the generator and every docs page is in the index.
- `tests/protocol-compat.test.ts`: [permanent] the live routes keep every route and field of the current snapshot; a removed field fails by route id; an added route passes.
- `tests/org-check.test.ts`: [permanent] over a fake fetcher, a wrong homepage, a missing README block, a PR without the footer and an unlisted public repo are each reported by name; a clean org reports nothing.
- `scripts/probes/org-brand.sh`: [permanent] the nightly goal run checks the real org.

## Mutation
```json
{"name":"compat: removals allowed","file":"tests/protocol-compat.test.ts","find":"const breaking = [...was].filter((k) => !now.has(k));","replace":"const breaking: string[] = [];","test":"tests/protocol-compat.test.ts"}
```
```json
{"name":"org: homepage unchecked","file":"scripts/org-check.ts","find":"if (repo.homepage !== \"https://kaas.team\")","replace":"if (false)","test":"tests/org-check.test.ts"}
```

## Acceptance
- AC-1: llms.txt is generated from the docs and stays in sync: checked by `make test FILES="tests/llms.test.ts"` (T1)
- AC-2: a breaking protocol change under the same major fails the gate: checked by `make test FILES="tests/protocol-compat.test.ts"` (T2)
- AC-3: every public repo is checked for the kaas.team homepage, the README block and the PR footer: checked by `make test FILES="tests/org-check.test.ts"` (T3)
- AC-4: the org check runs against the real org as a goal probe: checked by `make check` (T3)

## Non-goals
- NG-1: hosting factory.kaas.team/docs (DNS, the static site) is an operator step; the links in `llms.txt` point at it.
- NG-2: no docs rewrite; pages keep their content and gain only the index.
- NG-3: no SDK compat test beyond the protocol shape; the SDK re-exports the protocol types.

## Files
- `docs/index.md` (new)
- `docs/versioning.md` (new)
- `llms.txt` (new)
- `scripts/gen-llms.ts` (new)
- `scripts/protocol-snapshot.ts` (new)
- `scripts/org-check.ts` (new)
- `scripts/probes/org-brand.sh` (new)
- `packages/protocol/compat/v1.json` (new)
- `tests/llms.test.ts` (new)
- `tests/protocol-compat.test.ts` (new)
- `tests/org-check.test.ts` (new)
- `goals.json`
- `Makefile`

## Risk: low
Docs, a generator and two checks; nothing in the runner changes. The org probe calls GitHub and can fail on rate limits, so it is a nightly goal probe, never in the PR gate. Rollback: revert the PR.
## Model: sonnet

