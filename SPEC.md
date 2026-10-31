<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-1 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: medium

## Why
The factory's own runs are the first sessions mission control must show, and they need no vendor key: every run and stage attempt already sits in `state.db`. One adapter turns them into `AgentSession` rows, follows a run through its event log, links out to the pull request, and maps cancel and follow-up onto the steer verbs the dashboard and chat surfaces already use. A cloud session a stage started (a Claude Code, Cursor or Codex session id) becomes a child row, so the vendor adapters in mc-4 to mc-6 enrich it instead of finding it twice.

## Today
- `src/state.ts:405` `listRuns(repo?)`, `:397` `getRun(repo, issue)`, `:438` `listEvents(runId, {after, limit})` and `:501` `listStageRuns(repo, {issue, after, limit})` read everything the adapter needs; `StageRun` carries `model`, `cost_usd` (NULL when unknown), `session_id` and `config_hash`.
- `src/state.ts:659` `busEvents(limit, after)` reads the CloudEvents bus by `seq`.
- `src/integrations/steer.ts:12` `Steer` and `:46` `applySteer(tracker, repo, steer, by)` turn `cancel`, `answer`, `revise`, `approve` and `retry` into the tracker writes the inbox expects; `:67` `roleFor` names the role each needs.
- `src/agents/presets/` names the harness of each stage run (`claude`, `codex`, `cursor`, `acp`, and others).
- No module reads runs as sessions.

## Change
### T1: Runs as sessions
Files: `src/mc/adapters/factory.ts`, `tests/mc-adapter-factory.test.ts`
Model: sonnet
1. `factoryAdapter(deps: { state: Pick<FactoryState, "listRuns" | "getRun" | "listEvents" | "listStageRuns">; repos: () => string[]; tracker: SteerTracker; actor: string; dashboardUrl?: string })` with `kind: "factory"` and caps `{list: true, events: "poll", cancel: true, followUp: true, deepLink: true}`.
2. `list` maps each run to an `AgentSession`: `externalId` is `<repo>#<issue>`, `state` is `fromRunStatus(run.status)`, `stage`, `costUsd` (null when any stage cost is unknown), `prUrl`, `configHash`, and `needsYou` from `run.reason` when the state is `waiting`. `link` is the pull request when there is one, else `<dashboardUrl>/runs/<id>` when `dashboardUrl` is https, else absent.
3. Each stage run with a `session_id` and a cloud harness adds a child row `{runtime: <harness>, connection: "factory", externalId: <session_id>}` with the parent's repo, issue and stage, so a vendor adapter can match it by id.
4. `follow(ref, after)` polls `listEvents(runId, {after})` every 2 s, maps each row to a `SessionEvent` (`stage` on a stage change, `state` on a status change, `note` otherwise with `text` cut to 280 characters), and resolves with the last event id.
5. `cancel(ref)` is `applySteer(tracker, repo, {kind: "act", issue, action: "cancel", text: ""}, actor)`; `followUp(ref, text)` is the `answer` action when the run waits for information and `revise` when it waits for approval, else it throws `SessionUnsupported("this run is not waiting for anyone")`.
6. Tests use an in-memory state double and a fake tracker: the adapter passes `adapterKit`; a shipped run with a PR links to the PR; an unknown cost is `null`, never `0`; a run waiting for approval turns a follow-up into `revise`.

### T2: The mutations
Files: `tests/mutations/mc-unknown-factory-cost-shown-as-zero.json`, `tests/mutations/mc-follow-up-ignores-what-the-run-waits-for.json`
Model: haiku
Deps: T1
1. Save each entry under Mutation as its own file (`tests/mutations/mc-unknown-factory-cost-shown-as-zero.json`, `tests/mutations/mc-follow-up-ignores-what-the-run-waits-for.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-adapter-factory.test.ts`: [permanent] the kit passes; links, unknown cost, child sessions and steer mapping hold.

## Mutation
```json
{"name":"mc: unknown factory cost shown as zero","file":"src/mc/adapters/factory.ts","find":"costUsd: unknown ? null : total","replace":"costUsd: total","test":"tests/mc-adapter-factory.test.ts"}
```
```json
{"name":"mc: follow-up ignores what the run waits for","file":"src/mc/adapters/factory.ts","find":"run.status === \"awaiting-approval\" ? \"revise\" : \"answer\"","replace":"\"answer\"","test":"tests/mc-adapter-factory.test.ts"}
```

## Acceptance
- AC-1: every run reads as a session that passes the adapter kit, with child rows for cloud session ids: checked by `make test FILES=tests/mc-adapter-factory.test.ts` (T1)
- AC-2: cancel and follow-up go through the existing steer path, never a new write: checked by `make test FILES=tests/mc-adapter-factory.test.ts` (T1)

## Non-goals
- NG-1: no new table and no change to `src/state.ts`; the adapter only reads.
- NG-2: no log body or tool output in an event; the dashboard run page and the PR hold those.
- NG-3: no role check here; the route that calls `cancel` or `followUp` checks the role (mc-8).

## Files
- `src/mc/adapters/factory.ts` (new)
- `tests/mc-adapter-factory.test.ts` (new)
- `tests/mutations/mc-unknown-factory-cost-shown-as-zero.json` (new)
- `tests/mutations/mc-follow-up-ignores-what-the-run-waits-for.json` (new)
