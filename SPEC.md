<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Deps: none
Epic: e2-reliability
Milestone: phase-1
Runner: factory

## Risk: medium

## Why
Parallel factory PRs conflict on two shared files. `tests/mutations.json` is one JSON array that every PR appends to, so two PRs that each add an entry always conflict at the tail. `quality-baseline.json` holds per-file line caps on adjacent lines, so two PRs that change two caps conflict too. The merge path (`rebaseOnBase`) aborts on any conflict, so each merge forces a manual fix on every other open PR. This spec fixes the first conflict for good: a mutation can be its own file, `tests/mutations/<slug>.json`, so two PRs add two files and never touch the same line. The runner reads the old list and the new files side by side, so nothing breaks during the move. A migration script does the move later. Until then, a resolver on the rebase path merges both files on its own: it re-derives line caps from the real file sizes and merges the old list by entry name. Any other conflict still stops the rebase as it does today. The spec also lands #128: the prose test checks tracked Markdown only, so untracked runner output cannot turn the gate red. It is folded in here because it edits `tests/release.test.ts`, which this spec also edits.

## Today
- `scripts/check-mutations.ts:20` reads `tests/mutations.json` as one array (945 entries, one object per line, keys `name`, `file`, `find`, `replace`, `test`). `:75-76` throws when two entries share a name. `:81` reads the base list with `git show <base>:tests/mutations.json` for `--base`. `:89` throws `tests/mutations.json is empty`.
- `scripts/mutation-select.ts:8` `RUNS_ALL` holds `scripts/check-mutations.ts` and `scripts/mutation-select.ts`. `:10` `LIST = "tests/mutations.json"`. `:21-26` select an entry when its `file` or `test` is touched, or when the list changed and the entry is new or edited against `before`.
- `scripts/goals.ts:54` `repoAt(root)` reads `JSON.parse(read("tests/mutations.json") ?? "[]")`. `tests/goals.test.ts:67` asserts the message `is not in tests/mutations.json`, which stays.
- `src/tamper.ts:14` lists `tests/mutations.json` in `RUNNER_CONFIG`, so any diff that touches it, an append included, is a "runner config changed" hit. `src/proof.ts:31` `TEST_PATH` already treats any path under `tests/` as a test, so deleting a file under `tests/mutations/` is already a "test file deleted" hit.
- `scripts/check-tests-only.ts:29` `TEST_DATA` treats `tests/mutations.json` as data, not a test. `tests/check-tests-only.test.ts:93` pins that.
- `tests/release.test.ts:81-90` `OLD_NAME_KEPT` exempts `tests/mutations.json` from the old-name scan, because one entry contains the old repo name. `:114-123` "every tracked Markdown file passes check-prose" walks the tree with `readdirSync`, so an untracked `.factory/runs/issue-N/plan-comment.md` turns the gate red.
- `src/merge-autonomy.ts:109-120` `rebaseOnBase` runs `git rebase origin/<base>` and, on any failure, runs `git rebase --abort` and throws. `tests/merge-autonomy-push.test.ts:75-80` asserts that exactly two lines in that file contain `"push",`.
- `quality-baseline.json` is `JSON.stringify(obj, null, 2) + "\n"`, with top-level keys `comments`, `lines`, `names` and `exclude`, and the keys inside each object sorted. `tests/quality.test.ts:30` requires each `lines` value to equal the file's line count, which it computes as `text.split("\n").length - (text.endsWith("\n") ? 1 : 0)`.
- A slug of each current name (lowercase, every run of characters outside `a-z0-9` becomes `-`, leading and trailing `-` trimmed, cut to 80 characters, trailing `-` trimmed again) is unique across all 945 entries. The longest is 78 characters.
- Salvage: branch `factory/issue-151` holds only a claim commit, so there is nothing to keep. Branch `factory/issue-128` changes only `tests/release.test.ts` and merges onto main with no conflict. Its tip already uses `git ls-files -z`, which fixes the verify finding (paths with non-ASCII characters were quoted).
- `AGENTS.md:11-13` says each entry lives in `tests/mutations.json`.

## Change
### T1: one loader for the old list and the per-entry files
Files: `scripts/mutation-list.ts`, `scripts/check-mutations.ts`, `scripts/mutation-select.ts`, `scripts/goals.ts`, `tests/mutation-list.test.ts`, `tests/mutation-select.test.ts`
Model: sonnet
1. Create `scripts/mutation-list.ts`. Export `interface Mutation { readonly name: string; readonly file: string; readonly find: string; readonly replace: string; readonly test: string }`, `LEGACY_LIST = "tests/mutations.json"`, `MUTATIONS_DIR = "tests/mutations"`, and `isMutation(m: unknown): m is Mutation`, which is true when all five keys are strings.
2. Export `mutationSlug(name: string): string` as `name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "")`. Export `shardPath(name: string): string` returning `` `${MUTATIONS_DIR}/${mutationSlug(name)}.json` ``.
3. Export `loadMutations(root: string): Mutation[]`. When `<root>/tests/mutations.json` exists, read it as an array: these are the legacy entries. When `<root>/tests/mutations` exists, read every `*.json` in it, sorted by file name. Each file holds exactly one object. Throw `` `${rel}: not a mutation` `` when it fails `isMutation`. Throw `` `${rel}: file name must be ${shardPath(m.name)}` `` when its path is not `shardPath(m.name)`. Then build the list with exactly this line: `const all = [...legacy, ...shards];` and throw `` `mutation "${name}" is listed twice` `` on a duplicate name. With neither the file nor the folder, return `[]`.
4. Export `shardText(m: Mutation): string` returning `` `${JSON.stringify({ name: m.name, file: m.file, find: m.find, replace: m.replace, test: m.test }, null, 2)}\n` ``. This is the one format a shard is written in.
5. `scripts/check-mutations.ts`: replace the read at `:20` with `loadMutations(ROOT)`, and import `Mutation` from `./mutation-list` in place of the local interface. Delete the duplicate check at `:75-76`, because the loader does it. Change the empty-list error at `:89` to `the mutation list is empty`. Keep `--base` reading only the legacy list at the base ref, as it does today. Update the header comment to name both places.
6. `scripts/mutation-select.ts`: add `"scripts/mutation-list.ts"` to `RUNS_ALL`. In the filter, select an entry whose own file changed, by adding this exact line as the first condition: `touched.has(shardPath(m.name)) ||`. The legacy rules stay as they are. Widen the generic to `T extends Scoped & { readonly name: string }`, and add `name` to `Scoped`.
7. `scripts/goals.ts`: `repoAt(root)` sets `mutations: loadMutations(root)`. The error text at `:127` stays.
8. `tests/mutation-list.test.ts`: in a temp root, write a legacy list with one entry and two shard files. `loadMutations` returns all three, legacy first. A shard whose file name is not its slug throws `file name must be`. A name in both the legacy list and a shard throws `listed twice`. A shard missing `test` throws `not a mutation`. `loadMutations(<repo root>)` returns every entry of the legacy list plus the six shards T5 adds. `mutationSlug` gives `a-b-c` for `"A: b  -- c!"` and is unique over the real legacy list.
9. `tests/mutation-select.test.ts`: give the fixtures a `name`. Add a test: a diff that touches only `shardPath(x.name)` selects `x` and nothing else, and a diff that touches `scripts/mutation-list.ts` selects everything.

### T2: the guards treat a mutation file as a mutation entry; prose reads tracked Markdown only
Files: `src/tamper.ts`, `scripts/check-tests-only.ts`, `tests/tamper.test.ts`, `tests/check-tests-only.test.ts`, `tests/release.test.ts`
Model: sonnet
1. `src/tamper.ts`: add `const SHARD = /^tests\/mutations\/[^/]+\.json$/;`. In `tamperHits`, after the `RUNNER_CONFIG` line, add exactly: ``if (SHARD.test(f.path) && !f.deleted && f.removed.length) hits.push(`${f.path}: mutation entry changed`);``. Adding a new file is not a hit, because a new mutation can only make the proof stronger. A deleted file is already a "test file deleted" hit. Keep `tests/mutations.json` in `RUNNER_CONFIG`.
2. `tests/tamper.test.ts`: a diff that adds `tests/mutations/a.json` gives `[]`. A diff that changes a line of it gives `tests/mutations/a.json: mutation entry changed`. A diff that deletes it gives a hit that contains `test file deleted`.
3. `scripts/check-tests-only.ts:29`: `TEST_DATA` also matches `(?:^|\/)tests\/mutations\/`. Update its comment. `tests/check-tests-only.test.ts:93`: add `"tests/mutations/a.json"` to the not-a-test list.
4. `tests/release.test.ts`: apply the salvage hunk with `git fetch origin factory/issue-128 && git diff origin/main...origin/factory/issue-128 -- tests/release.test.ts | git apply -3`. Keep all of it: the `markdownFiles(dir)` helper, which runs `git ls-files -z "*.md"` when `dir/.git` exists and otherwise walks the tree, skipping `.factory/runs/`; the `checkProse` helper; and the four helper tests. If the branch is gone, write the same thing from the #128 plan. Then add `"tests/mutations/"` to `OLD_NAME_KEPT`, so a moved entry that names the old repo is exempt the same way the list is.

### T3: the migration script, proven on a copy
Files: `scripts/split-mutations.ts`, `tests/mutation-list.test.ts`
Model: sonnet
Deps: T1
1. Create `scripts/split-mutations.ts`. Export `splitMutations(root: string): number`. It reads `<root>/tests/mutations.json`. If two entries share a slug, it throws naming both before writing anything. It writes each entry with `shardText` to `<root>/<shardPath(name)>`, throwing if that file exists with different text. Then it deletes the legacy file and returns the number moved. Its main (`import.meta.main`) takes `--root <dir>` (default: the repo root) and prints `split-mutations: moved <n> entries to tests/mutations/`.
2. `tests/mutation-list.test.ts`: copy the real `tests/mutations.json` into a temp root, run `splitMutations` on it, and assert three things: the legacy file is gone; `loadMutations(tmp)` sorted by name deep-equals the real legacy list sorted by name; and a second run throws because the file is gone. A list with two names that share one slug throws and writes nothing.
3. Do not run the script on this repo. Running it is an operator step once in-flight branches have drained (NG-1).

### T4: re-sync the baseline and the old list during a rebase
Files: `src/rebase-sync.ts`, `src/merge-autonomy.ts`, `tests/rebase-sync.test.ts`
Model: sonnet
1. Create `src/rebase-sync.ts`. Export `pick3<T>(ours: T | undefined, theirs: T | undefined, base: T | undefined): { value: T | undefined } | undefined`, a three-way pick on equal values, written as exactly these three lines: `if (ours === theirs || theirs === base) return { value: ours };`, `if (ours === base) return { value: theirs };` and `return undefined;`. Callers compare JSON strings, so `===` is value equality.
2. Export `mergeBaseline(ours: string, theirs: string, base: string | undefined, worktree: string): string | undefined`. Parse all three (a missing base is `{}`). For each top-level key except `lines`: when both sides hold an object, pick each inner key with `pick3` over `JSON.stringify` of the values and sort the inner keys; otherwise `pick3` the whole value. Any `undefined` pick means a real conflict, and the function returns `undefined`. For `lines`, take every key from ours and theirs, sorted. For each file that exists in `worktree`, set the cap with exactly this line: `lines[file] = lineCount(readFileSync(path, "utf8"));`. Drop the key when the file is gone. `lineCount` is the count `tests/quality.test.ts:32` uses, and that test only asks each `lines` value to equal its file's size. (`scripts/kaas/check-quality.py` skips this baseline, because its top-level `exclude` list makes `ours()` false, so `lines` is the only section a test enforces.) Keep the top-level key order of ours and return `JSON.stringify(out, null, 2) + "\n"`.
3. Export `mergeMutationList(ours: string, theirs: string, base: string | undefined): string | undefined`. Split each side into entry lines: the lines between `[` and `]`, trimmed, with one trailing comma dropped. Parse each line to read its `name`, keyed by name to the raw line text. Return `undefined` if any line does not parse. Go through the names in order: those of ours in their order, then those only in theirs in their order. `pick3` each name's raw line, and return `undefined` on any conflict. Drop the names whose pick is `undefined`, because one side deleted them. Return `"[\n" + kept.map((l) => "  " + l).join(",\n") + "\n]\n"`, which keeps each line byte for byte.
4. Export `syncRebase(worktree: string): Promise<boolean>`, which is called while a rebase is stopped. It loops at most 200 times, and each pass does five things. (a) It lists unmerged paths with `git diff --name-only --diff-filter=U`. (b) It returns `false` if any of them is not `quality-baseline.json` or `tests/mutations.json`. (c) For each path, it reads stages `:1:`, `:2:` and `:3:` with `git show`. A missing stage 1 is `undefined`. In a rebase, stage 2 is ours (the base side) and stage 3 is theirs (the commit being replayed). It merges with the function above and returns `false` on `undefined`. Otherwise it writes the file and runs `git add`. (d) It runs `git rebase --continue` with `GIT_EDITOR=true` in the env. If that exits 0 and `git rev-parse --git-path rebase-merge` no longer exists, it returns `true`. If it fails with no unmerged paths and `git diff --cached --quiet` exits 0, it runs `git rebase --skip`. (e) It loops again. It uses its own `Bun.spawn` helper that returns the exit code and stdout, and it never pushes.
5. `src/merge-autonomy.ts` `rebaseOnBase`: the rebase `catch` first runs `if (await syncRebase(worktree)) return;`. Only after that does it abort and rethrow, as today. Import `syncRebase` from `./rebase-sync`. Add no line that contains `"push",`.
6. `tests/rebase-sync.test.ts`: build a bare origin and a clone, the same way `tests/merge-autonomy-push.test.ts:20-64` does. The base commit has `a.ts` and `b.ts` (401 lines each, so both are over the 400 limit), a `quality-baseline.json` whose `lines` are `{"a.ts": 401, "b.ts": 401}`, and a `tests/mutations.json` with one entry. On `main`, grow `b.ts` to 405 lines, set `b.ts` to 405 and append entry `Y`. On `feature`, grow `a.ts` to 402 lines, set `a.ts` to 402 and append entry `X`. Then `rebaseOnBase(work, "main", "feature")` resolves, and the result has five properties. The origin's `feature` equals the returned head. `lines` is `{"a.ts": 402, "b.ts": 405}`. The list holds the base entry, `Y`, then `X`. Neither file contains `<<<<<<<`. No rebase is in progress. A second fixture where both branches edit `c.txt` makes `rebaseOnBase` reject, with HEAD unchanged and no rebase in progress. Unit tests cover the rest: `pick3` returns `undefined` when both sides changed the same key differently; `mergeMutationList` returns `undefined` when both sides edited one name differently, and drops a name one side deleted; `mergeBaseline` drops a `lines` key whose file is gone.

### T5: the new checks as mutation files, and the docs
Files: `tests/mutations/mutation-list-the-loader-drops-the-shard-files.json`, `tests/mutations/mutation-select-a-changed-shard-does-not-select-its-entry.json`, `tests/mutations/tamper-an-edited-mutation-shard-passes.json`, `tests/mutations/rebase-sync-the-merged-list-keeps-only-the-base-side.json`, `tests/mutations/rebase-sync-line-caps-are-not-re-derived.json`, `tests/mutations/release-the-markdown-list-is-read-without-z.json`, `AGENTS.md`
Model: haiku
Deps: T1 T2 T4
1. Write each of the six entries under Mutation to its own file, `shardPath(name)`, in `shardText` format. The six file names are listed in this task's Files line. Do not add them to `tests/mutations.json`.
2. `AGENTS.md:11-13`: say that each entry is one file, `tests/mutations/<slug>.json`, named by `mutationSlug` of its name. Say that `tests/mutations.json` is the old list, still read until `scripts/split-mutations.ts` moves it, and that a new check lands with its mutation file in the same change. No em dashes.
3. Run `bun scripts/check-mutations.ts "<name>"` for each of the six names. Each must print `bites`.

## Tests
- `tests/mutation-list.test.ts`: [permanent] the loader merges the old list and the per-entry files, and rejects a wrong file name, a duplicate name and a malformed entry; the slug is unique over the real list; the migration on a copy of the real list round-trips and refuses slug collisions.
- `tests/mutation-select.test.ts`: [permanent] a changed per-entry file selects its entry; a loader change runs everything; the existing cases still pass.
- `tests/tamper.test.ts`: [permanent] an added mutation file is not a hit; an edited one is; a deleted one is.
- `tests/check-tests-only.test.ts`: [permanent] a mutation file is data, not a test.
- `tests/release.test.ts`: [permanent] the Markdown list leaves out untracked files, returns non-ASCII paths unquoted, applies the skip list, and falls back to a walk without `.git`.
- `tests/rebase-sync.test.ts`: [permanent] two branches that each append a mutation and change a different line cap rebase with both entries and both caps and no markers; a conflict in another file still fails the rebase.
- `tests/merge-autonomy-push.test.ts`, `tests/goals.test.ts`, `tests/quality.test.ts`: [permanent] existing; still pass.

## Mutation
```json
{"name":"mutation list: the loader drops the shard files","file":"scripts/mutation-list.ts","find":"const all = [...legacy, ...shards];","replace":"const all = [...legacy];","test":"tests/mutation-list.test.ts"}
```
```json
{"name":"mutation select: a changed shard does not select its entry","file":"scripts/mutation-select.ts","find":"touched.has(shardPath(m.name)) ||","replace":"","test":"tests/mutation-select.test.ts"}
```
```json
{"name":"tamper: an edited mutation shard passes","file":"src/tamper.ts","find":"if (SHARD.test(f.path) && !f.deleted && f.removed.length)","replace":"if (false)","test":"tests/tamper.test.ts"}
```
```json
{"name":"rebase sync: the merged list keeps only the base side","file":"src/rebase-sync.ts","find":"if (ours === base) return { value: theirs };","replace":"if (ours === base) return { value: ours };","test":"tests/rebase-sync.test.ts"}
```
```json
{"name":"rebase sync: line caps are not re-derived","file":"src/rebase-sync.ts","find":"lines[file] = lineCount(readFileSync(path, \"utf8\"));","replace":"lines[file] = 0;","test":"tests/rebase-sync.test.ts"}
```
```json
{"name":"release: the Markdown list is read without -z","file":"tests/release.test.ts","find":"[\"git\", \"ls-files\", \"-z\", \"*.md\"]","replace":"[\"git\", \"ls-files\", \"*.md\"]","test":"tests/release.test.ts"}
```

## Acceptance
- AC-1: the runner reads the old list and every per-entry file as one list, and refuses a duplicate name or a misnamed file: checked by `make test FILES=tests/mutation-list.test.ts` (T1)
- AC-2: on a PR, a changed per-entry file selects its own entry: checked by `make test FILES=tests/mutation-select.test.ts` (T1)
- AC-3: adding a mutation file is not a tamper hit, while editing one is: checked by `make test FILES=tests/tamper.test.ts` (T2)
- AC-4: a mutation file counts as data for the tests-only check: checked by `make test FILES=tests/check-tests-only.test.ts` (T2)
- AC-5: the prose test checks tracked Markdown only, with non-ASCII paths unquoted: checked by `make test FILES=tests/release.test.ts` (T2)
- AC-6: the migration moves the real list into per-entry files with nothing lost: checked by `make test FILES=tests/mutation-list.test.ts` (T3)
- AC-7: a rebase whose only conflicts are line caps and appended mutations finishes with both sides kept, and any other conflict still stops it: checked by `make test FILES=tests/rebase-sync.test.ts` (T4)
- AC-8: the merge path still pushes with `--no-verify` and only twice: checked by `make test FILES=tests/merge-autonomy-push.test.ts` (T4)
- AC-9: the goals script still finds each named mutation: checked by `make test FILES=tests/goals.test.ts` (T5)

## Non-goals
- NG-1: do not run `scripts/split-mutations.ts` on this repo, and do not delete or shrink `tests/mutations.json`. The move is an operator step after in-flight branches drain. A test that freezes the old list's size lands with that move.
- NG-2: no change to `.claude/rules/template.md` (a protected path) or to the `Makefile` comment at `:43` (a tamper hit). The operator updates both with the move.
- NG-3: do not touch `.github/workflows`. `mutations.yml` already triggers on `tests/**`.
- NG-4: no resolver for any file other than `quality-baseline.json` and `tests/mutations.json`, and no change to which issues run together.
- NG-5: one PR for this spec, whose body follows `.github/pull_request_template.md`. Every commit carries the `Signed-off-by:` line from `CONTRIBUTING.md`. No em dashes in code, comments, docs or the PR. Each new file stays at 400 lines or fewer, with comment runs of 3 lines at most, so it needs no line baseline. Touch nothing outside Files.

## Files
- `scripts/mutation-list.ts` (new)
- `scripts/split-mutations.ts` (new)
- `src/rebase-sync.ts` (new)
- `tests/mutation-list.test.ts` (new)
- `tests/rebase-sync.test.ts` (new)
- `tests/mutations/mutation-list-the-loader-drops-the-shard-files.json` (new)
- `tests/mutations/mutation-select-a-changed-shard-does-not-select-its-entry.json` (new)
- `tests/mutations/tamper-an-edited-mutation-shard-passes.json` (new)
- `tests/mutations/rebase-sync-the-merged-list-keeps-only-the-base-side.json` (new)
- `tests/mutations/rebase-sync-line-caps-are-not-re-derived.json` (new)
- `tests/mutations/release-the-markdown-list-is-read-without-z.json` (new)
- `scripts/check-mutations.ts` (edit: reads `loadMutations`)
- `scripts/mutation-select.ts` (edit: selects by the entry's own file)
- `scripts/goals.ts` (edit: reads `loadMutations`)
- `scripts/check-tests-only.ts` (edit: mutation files are data)
- `src/tamper.ts` (edit: an edited mutation file is a hit)
- `src/merge-autonomy.ts` (edit: `rebaseOnBase` tries `syncRebase` before aborting)
- `tests/mutation-select.test.ts` (edit)
- `tests/tamper.test.ts` (edit)
- `tests/check-tests-only.test.ts` (edit)
- `tests/release.test.ts` (edit: the #128 hunk and `OLD_NAME_KEPT`)
- `AGENTS.md` (edit: where a mutation lives)
