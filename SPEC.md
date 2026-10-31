<!-- factory:planned v1 -->
Blocked by: #253
## Why
The agent37 runtime fails on any gate over 15 minutes (one exec answers 504 while the command keeps running, then the pool restarts the gate and the cleanup deletes its directory), uploads the worktree one chunk at a time, hides truncated output, leaks run directories on a sleeping instance, cannot show its wallet, runs every gate on one box, and has no live test or hosted-worker recipe. All of it lives in one adapter, so one epic and one PR replaces seven overlapping ones (#231, #233, #234, #235, #236, #237, #238).

## Today
- `src/adapters/agent37/execution.ts` runs the gate as one blocking exec, uploads chunks in sequence, drops `truncated`, skips cleanup after an abort, and names one instance.
- `src/runtimes.ts` gives agent37 one `instance` string.
- `tests/live/runtimes.ts` lists ssh, wrap and http-sandbox only.
- `docs/runtimes.md` says a longer step needs another runtime and calls the pool a free tier.

## Change
### T1: Run the gate detached and poll for its exit
Files: `src/adapters/agent37/execution.ts`, `tests/fixtures/agent37.ts`, `tests/runtimes.test.ts`, `docs/runtimes.md`
Model: sonnet
1. Start the command as `nohup bash -c cmd > dir.out 2> dir.err; echo $? > dir.code` in the background so the start exec returns at once.
2. Poll every 5 s with `cat dir.code` until it exists, then read `dir.out` and `dir.err` (tail 512 KB each, keep the FACTORY_GATES line) and return them with the exit code.
3. On abort, kill the recorded pid before removing the directory.
4. The fixture gains `maxWaitMs`, answering 504 after that long while the command keeps running.
5. In docs/runtimes.md replace the 15 minute sentence with the poll design and its cost (one exec per 5 s).

### T2: Upload parts in parallel and surface truncation
Files: `src/adapters/agent37/execution.ts`, `tests/runtimes.test.ts`
Model: sonnet
1. Write chunk i to `dir.b64.<i>` with up to 8 execs in flight, then `cat` the parts in order into the archive. `CHUNK` stays 96 KB.
2. When the answer has `truncated: true`, append `agent37: output truncated at 512 KB per stream` to stderr.
3. Spawn tar with `COPYFILE_DISABLE=1` in its env.

### T3: Reap stale run directories
Files: `src/adapters/agent37/execution.ts`, `tests/runtimes.test.ts`
Model: haiku
1. Prefix the setup exec with `find <root> -mindepth 1 -maxdepth 1 -mmin +120 -exec rm -rf {} +`.

### T4: Read instance status and wallet balance
Files: `src/adapters/agent37/execution.ts`, `src/runtimes.ts`, `src/cli-runtime.ts`, `tests/fixtures/agent37.ts`, `tests/runtimes.test.ts`, `docs/runtimes.md`
Model: sonnet
1. Add an optional `apiUrl` (default `https://api.agent37.com`) to the agent37 shape.
2. `Agent37Execution.account()` calls `GET /v1/instances/<id>` and `GET /v1/billing` with a bearer key and returns `{status, balance}`; a failure returns the reason and never throws.
3. `factory runtime list --probe` appends `instance sleeping, wallet $4.20` to an agent37 row.
4. docs/runtimes.md says agent37 has no free minutes, a member's `minutes` is the operator's own cap, and awake billing includes the idle timeout after each run.

### T5: Spread runs over several instances
Files: `src/adapters/agent37/execution.ts`, `src/runtimes.ts`, `tests/runtimes.test.ts`
Model: sonnet
1. Accept `instances: string[]` as an alternative to `instance`; naming both is a runtime problem at load.
2. Each `run` takes the instance with the fewest runs in flight in this process, ties by order, and releases it in `finally`.

### T6: Add agent37 to the live runtime suite
Files: `tests/live/runtimes.ts`, `integrations/agent37/manifest.json`, `docs/integrations.md`
Model: haiku
1. Add `agent37` with env `FACTORY_LIVE_AGENT37_INSTANCE` and `FACTORY_LIVE_AGENT37_KEY`, spec `{kind: "agent37", instance, tokenEnv: "FACTORY_LIVE_AGENT37_KEY"}`.
2. Add the same names to the manifest's live block and regenerate the table with `bun scripts/gen-integrations-doc.ts`.

### T7: Document a worker on a hosted instance and refuse its own gates
Files: `docs/runtimes.md`, `src/machine.ts`, `tests/machine.test.ts`
Model: sonnet
1. Add "A worker on a hosted instance": create with `agent37-claude-code`, `auto_sleep: false`, credentials as create-time `env`, then `factory daemon install --repo <owner/name>` over ssh. Say the worker shares one model plan's rate limit and its gates must run on another runtime.
2. When `FACTORY_AGENT37_INSTANCE` is set, loading machine.json fails if an agent37 runtime names that same instance, with a message naming the env var.

## Tests
- `tests/runtimes.test.ts`: with `maxWaitMs: 200`, `sleep 1; echo done` returns stdout `done` and code 0; an aborted run leaves no process and no directory.
- `tests/runtimes.test.ts`: a 1 MB file round-trips with at most 8 concurrent part writes; `truncated: true` adds the stderr line.
- `tests/runtimes.test.ts`: a run directory three hours old is gone after `run("true")` and one a minute old is kept.
- `tests/runtimes.test.ts`: `account()` returns `{status: "sleeping", balance: 4.2}` and sends the bearer key; three concurrent runs over two instances land on both; `instance` plus `instances` is refused; docs/runtimes.md contains `agent37 has no free minutes` and `A worker on a hosted instance` and not `waits at most 15 minutes`.
- `tests/live-runtimes.test.ts`: skips naming the missing key when unset.
- `tests/integrations.test.ts`: table and manifests agree after regeneration.
- `tests/machine.test.ts`: a gate runtime on the worker's own instance is refused; a different one loads.

## Mutation
```json
{"name":"agent37: finished run directory kept","file":"src/adapters/agent37/execution.ts","find":"if (!signal?.aborted) await this.exec(token, `rm -rf","replace":"if (false) await this.exec(token, `rm -rf","test":"tests/runtimes.test.ts"}
```

Save it as its own file `tests/mutations/agent37-finished-run-directory-kept.json` (a single JSON object); never edit tests/mutations.json. Adjust `find` to text that occurs exactly once in the file and make sure the test goes red under it.

## Acceptance
- AC-1: a command longer than one exec's wait returns its output and exit code, and an abort kills it and removes its directory: checked by `make test FILES="tests/runtimes.test.ts"` (T1)
- AC-2: parts upload in parallel, truncation shows in stderr, stale directories are reaped: checked by `make test FILES="tests/runtimes.test.ts"` (T2)
- AC-3: account() reads status and wallet, several instances share the load, and the docs carry the new sentences: checked by `make test FILES="tests/runtimes.test.ts"` (T4)
- AC-4: the live suite has an agent37 target that skips without keys: checked by `make test FILES="tests/live-runtimes.test.ts tests/integrations.test.ts"` (T6)
- AC-5: a worker cannot run its gates on its own instance: checked by `make test FILES="tests/machine.test.ts"` (T7)

## Non-goals
- NG-1: no streaming of gate output to the dashboard, no change to the http runtime protocol.
- NG-2: no ssh or files API transport; `.git` stays unsent.
- NG-3: no dollar-based pool accounting, no cross-process lease, no automatic instance creation.
- NG-4: agent37 does not become an `agentRuntime` kind.

## Files
- `src/adapters/agent37/execution.ts`
- `src/runtimes.ts`
- `src/cli-runtime.ts`
- `src/machine.ts`
- `tests/fixtures/agent37.ts`
- `tests/runtimes.test.ts`
- `tests/live/runtimes.ts`
- `tests/live-runtimes.test.ts`
- `tests/integrations.test.ts`
- `tests/machine.test.ts`
- `integrations/agent37/manifest.json`
- `docs/runtimes.md`
- `docs/integrations.md`
- `tests/mutations/agent37-finished-run-directory-kept.json` (new)

## Risk: medium
## Model: sonnet

