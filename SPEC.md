<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: E1 Finish reliability
Milestone: Phase 1 reliability
Runner: operator

## Risk: low

## Why
Two reliability gaps in the test run itself. First, the temp dir on the build machine once held 62,586 `factory-*` entries (#270): tests and the processes they start make temp dirs and files and many never remove them. Second, the watcher's stale-poll guard in `src/watch.ts` (a poll that listed an issue before that issue was released must skip it) has a test that never reaches the guard, so the mutation that removes the guard was dropped from `tests/mutations.json`. This change makes every test run clean its own temp files, and makes the stale-poll test bite so the mutation can come back.

## Today
- `tests/preload.ts` (preloaded by `bunfig.toml` for every `bun test`) sets `FACTORY_HOME` to a fresh `mkdtemp` dir under `tmpdir()` named `factory-home-*` and never removes it.
- A full `make test` on main, run with `TMPDIR` pointing at an empty dir, leaves 182 entries there (16 `factory-a37-*` from `tests/runtimes.test.ts`, 10 `factory-cs-*`, 9 `docs-links-*`, 8 `minion-run-*`, 8 `factory-home-*`, and others). They come from about 119 test files, not from `src/`: every `mkdtemp` caller in `src/` already removes its dir in a `finally`, and `.factory/gates.sh` already removes its log.
- Setting `process.env.TMPDIR` in the preload moves `os.tmpdir()` and `Bun.$` children, but not children started with `Bun.spawnSync` or `child_process` without an explicit `env`: those still see the `TMPDIR` the `bun test` process started with. So the preload alone leaves shell `mktemp` files behind; the `make test` recipe has to set `TMPDIR` as well.
- The `Makefile` `test` target is one line: `$(GIT_ENV) bun test -t '^(?!.*@quarantine)' --reporter=junit --reporter-outfile=reports/junit.xml $(TEST_ARGS) $(FILES)`. `tests/mutations.json` entry "quarantine: make test runs tagged tests" finds `bun test -t '^(?!.*@quarantine)'` in the `Makefile`; that text must stay, exactly once.
- `src/watch.ts:673` is `if (released !== undefined && released > listedAt) return false;`. The test "a poll whose issue list predates an issue's release does not redispatch it from that stale list" (`tests/continuous-dispatch.test.ts:159-180`) overrides `listIssuesByLabel`, but `pollOnce` calls `listIssuesByLabels`, so the override never runs and the test passes with line 673 deleted.

## Change
### T1: the stale-poll test reaches the guard, and its mutation returns
Files: `tests/continuous-dispatch.test.ts`, `tests/mutations.json`
Model: sonnet
1. In `tests/continuous-dispatch.test.ts`, replace the whole test at lines 159-180 with this exact test (keep the same name):
```ts
  test("a poll whose issue list predates an issue's release does not redispatch it from that stale list", async () => {
    // The second poll lists #1 as ready while the first is running it, and its
    // list comes back only after #1 has parked and left inFlight.
    const inFlight = new Set<number>();
    const { deps, config, executor, workspacesDir, cloneDir } = setup(() => 10);
    const released = () => executor.starts.includes(1) && !inFlight.has(1);
    class StaleGitHub extends FakeGitHub {
      override async listIssuesByLabels(repo: string, labels: readonly string[]): Promise<Map<string, GhIssue[]>> {
        const snapshot = await super.listIssuesByLabels(repo, labels);
        for (let t = 0; t < 3000 && !released(); t += 10) await Bun.sleep(10);
        return snapshot;
      }
    }
    const stale = { ...deps, github: new StaleGitHub([baseIssue(1, ["factory:ready"])]) };
    const first = pollOnce(deps, config, inFlight);
    const second = pollOnce(stale, config, inFlight);
    await Promise.all([first, second]);
    expect(released()).toBe(true);
    expect(executor.starts).toEqual([1]);
    rmSync(workspacesDir, { recursive: true, force: true });
    rmSync(cloneDir, { recursive: true, force: true });
  });
```
2. Check the signature of `listIssuesByLabels` in `tests/harness.ts` (`FakeGitHub`) and `src/github.ts`; if the parameter or return types differ from the override above, match them exactly and keep the body.
3. Add the first entry under Mutation to `tests/mutations.json`, directly after the entry named "watch: inFlight released per issue".

### T2: one temp root per test run, removed when the run ends
Files: `tests/preload.ts`, `Makefile`, `tests/temp-leak.test.ts`, `tests/mutations.json`
Model: sonnet
1. Replace the whole of `tests/preload.ts` with exactly:
```ts
// A test that falls back to the real ~/.factory would read whatever repos ran on this machine.
// Every temp dir a test or the code under it makes lands in one root, removed when the run ends (#270).
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-test-"));
process.env.TMPDIR = root;
process.env.FACTORY_HOME = join(root, "home");
mkdirSync(process.env.FACTORY_HOME);
delete process.env.FACTORY_REPOS;
afterAll(() => rmSync(root, { recursive: true, force: true }));
```
2. In the `Makefile`, replace the two-line `test` recipe (the `@mkdir -p reports` line stays) so the target reads exactly as below, with tab-indented recipe lines and the comment line directly above `test:`:
```
# Every temp file a test, or a process it starts, makes lands in one dir, removed when the run ends (#270).
test:
	@mkdir -p reports
	@root=$$(mktemp -d "$${TMPDIR:-/tmp}/factory-test-run.XXXXXX"); \
	$(GIT_ENV) TMPDIR=$$root bun test -t '^(?!.*@quarantine)' --reporter=junit --reporter-outfile=reports/junit.xml $(TEST_ARGS) $(FILES); \
	code=$$?; rm -rf "$$root"; exit $$code
```
3. Create `tests/temp-leak.test.ts`. It holds a fixture test file as a string, `LEAKY`, that: makes `mkdtempSync(join(tmpdir(), "factory-a37-"))` and writes a file `f` in it; when `process.env.LEAK_SHELL` is set, runs `Bun.spawnSync(["sh", "-c", "mktemp \"${TMPDIR:-/tmp}/factory-gate.XXXXXX\""])`; and ends with `expect(process.env.LEAK_FAIL).toBeUndefined();`. A helper `childRun(cmd: string[], env: Record<string, string>): { code: number; left: string[] }` makes an outer `mkdtemp` dir, makes `tmp/` inside it, writes `LEAKY` to `leaky.test.ts` in the outer dir, replaces the token `<file>` in `cmd` with that file's path, runs `Bun.spawnSync(cmd, { cwd: <repo root>, env: { ...process.env, ...env, TMPDIR: <outer>/tmp } })`, returns `{ code: exitCode, left: readdirSync(<outer>/tmp) }`, and removes the outer dir in a `finally`. Four tests:
   - "bun test removes the temp dirs a test made and never cleaned": `childRun(["bun", "test", "<file>"], {})` equals `{ code: 0, left: [] }`.
   - "make test removes temp files a child process made outside the test's own process": `childRun(["make", "-s", "test", "FILES=<file>"], { LEAK_SHELL: "1" })` equals `{ code: 0, left: [] }`.
   - "make test still fails when a test fails, and still cleans up": with `{ LEAK_SHELL: "1", LEAK_FAIL: "1" }` the code is not 0 and `left` is `[]`.
   - "a test sees a temp dir under its run's own root, and FACTORY_HOME inside it": some path segment of `tmpdir()` starts with `factory-test-`, and `process.env.FACTORY_HOME` starts with `tmpdir()`.
4. Add the remaining three entries under Mutation to `tests/mutations.json`, directly after the entry added in T1.
5. Run the full `make test` once with `TMPDIR` set to a new empty dir and confirm that dir is empty afterwards and the suite has 0 failures. If a test fails only because it assumed `tmpdir()` is the system temp dir, fix that test's assumption in the smallest way and list the file in the PR body; do not change `src/`.

## Tests
- `tests/continuous-dispatch.test.ts`: [permanent] the stale-poll test now goes through `listIssuesByLabels`, waits until #1 has been released, and fails when the guard at `src/watch.ts:673` is removed.
- `tests/temp-leak.test.ts`: [permanent] a child `bun test` and a child `make test` both leave the temp dir they were given empty, a failing child `make test` keeps its non-zero exit and still cleans up, and tests run under the per-run root.
- `tests/quarantine.test.ts`: [permanent] existing; the `make test` filter text is unchanged.

## Mutation
```json
{"name": "watch: a stale poll skips an issue released after it listed", "file": "src/watch.ts", "find": "if (released !== undefined && released > listedAt) return false;", "replace": "", "test": "tests/continuous-dispatch.test.ts"}
```
```json
{"name": "tests: the preload removes its temp root", "file": "tests/preload.ts", "find": "afterAll(() => rmSync(root, { recursive: true, force: true }));", "replace": "", "test": "tests/temp-leak.test.ts"}
```
```json
{"name": "tests: make test removes its temp root", "file": "Makefile", "find": "code=$$?; rm -rf \"$$root\"; exit $$code", "replace": "code=$$?; exit $$code", "test": "tests/temp-leak.test.ts"}
```
```json
{"name": "tests: make test keeps a failing exit code", "file": "Makefile", "find": "code=$$?; rm -rf \"$$root\"; exit $$code", "replace": "code=$$?; rm -rf \"$$root\"; exit 0", "test": "tests/temp-leak.test.ts"}
```

## Acceptance
- AC-1: a poll whose list predates an issue's release does not dispatch it again: checked by `make test FILES=tests/continuous-dispatch.test.ts` (T1)
- AC-2: a test run removes every temp dir and file its tests, and processes they start, made; a failing run still fails: checked by `make test FILES=tests/temp-leak.test.ts` (T2)
- AC-3: the quarantine filter in `make test` is unchanged: checked by `make test FILES=tests/quarantine.test.ts` (T2)
- AC-4: the types still check: checked by `make typecheck` (T2)

## Non-goals
- NG-1: no per-file cleanup sweep across the 119 test files that leave temp dirs; the run-level root covers them.
- NG-2: no change to `src/` (the `src/` temp callers already clean up), `src/watch.ts` included: T1 only makes the existing guard tested.
- NG-3: no change to `scripts/check-mutations.ts` or how it copies the repo.
- NG-4: do not touch `.github/workflows`. Keep the PR body to the repo's PR template with its sign-off lines; one PR for this spec; no em dashes in code, comments or the PR; no file outside Files below.

## Files
- `tests/temp-leak.test.ts` (new)
- `tests/continuous-dispatch.test.ts` (edit: the stale-poll test overrides `listIssuesByLabels` and waits for the release)
- `tests/preload.ts` (edit: one temp root per run, `TMPDIR` and `FACTORY_HOME` inside it, removed in `afterAll`)
- `Makefile` (edit: `test` runs under a per-run `TMPDIR` and removes it, keeping the exit code)
- `tests/mutations.json` (edit: add the four entries)
