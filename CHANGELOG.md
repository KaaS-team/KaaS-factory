# Changelog

## v5.2.0

The dashboard becomes a control plane: people sign in, each has a role, and every command from the
web is written to the tracker first. Upgraders: `FACTORY_DASHBOARD_TOKEN` keeps working as the
break-glass owner; set `FACTORY_GITHUB_CLIENT_ID` and `FACTORY_GITHUB_CLIENT_SECRET` to turn on
GitHub sign-in. See [docs/control-plane.md](docs/control-plane.md).

- Sign-in and roles: GitHub sign-in, with viewer, approver, operator and owner roles kept in
  `plane.db`. Every route names the least role it needs, and a test walks every route against every
  role. A member is pinned to their GitHub account id, so a renamed login cannot be taken over.
- Audit: every write from a signed-in caller is a row, refusals included, and owners read it at
  `GET /api/audit`.
- Commands: start a task, approve a plan, revise, answer, retry and cancel from the web. Each is a
  comment on the issue, posted before the route answers and signed with who sent it, so a runner
  that only polls still obeys it. A command the issue is not waiting for is refused with 409.
- Tracker footers are sealed to the issue they live in, so a runner-written description pasted
  into another issue reads as plain text there. A created issue with markers is written twice; see
  docs/decisions/native-trackers.md.
- Only comments from people with write access or higher are read when a run resumes. A read-only
  collaborator's revise text no longer reaches the agent, and their comment no longer holds a
  maintainer's reply.
- Not in this release: the factory as an MCP server (goal: factory-mcp-server), messages sent while
  a stage runs and taking over a run (goal: mid-run-commands), and setting the autonomy mode from
  the web (goal: set-mode-web). The audit row of a refused request does not record its issue yet.
  One timing test in `tests/continuous-dispatch.test.ts` is known to fail now and then on a busy
  machine; it passes on rerun.

## v5.1.0

Software Factory is now KaaS Factory, an open-core product. Upgraders: point `FACTORY_RUNNER_REF`
and any clone at `KaaS-team/KaaS-factory`; the `factory` command and `FACTORY_*` variables keep
their names.

- Name: the package is `kaas-factory`, and the docs, CI, dashboard, service unit and fallback git
  identity say KaaS Factory; the Rust crates were already `kaas-verify` and `kaas-relay`. A test
  fails on the old name anywhere outside history, recorded transcripts and the vendored kit.
- Licence: the core is Apache-2.0, copyright Secret SaaS OÜ. `ee/` is under the KaaS Factory
  Enterprise License, the name and icon are reserved (`TRADEMARKS.md`), the Geist font stays
  OFL-1.1 and ported files keep their MIT or Apache notice. `REUSE.toml` states each file's licence,
  `reuse lint` runs in `make check`, and a test fails when core code imports `ee/` or a runtime npm
  package appears.
- Contributions are signed off (DCO); CI fails a pull request with an unsigned commit or a sign-off
  that is not the author's. `CONTRIBUTING.md` says how.
- The lessons, demo scripts and research notes moved to the `factory/` folder of
  `learnwithparam/agentic-ai-lightning-sessions`, with the `worksheets` workflow and `make demo`.
  A test keeps teaching material out of the product.
- Code standards: `quality-baseline.json` freezes the 13 files over 400 lines and every long
  comment run at today's size; a test fails when one grows.
- Not in this release: `factory teach "<how we ship>"`, which writes workflows and skills from a
  plain description (goal: teach-command).

## v5.0.1

The goals ledger, so planned work is never dropped silently again. Upgraders: nothing to change.

- `goals.json` lists every ask in the asker's words, with its phase and the proof that it is done:
  a named test plus a mutation that turns it red, or a probe under `scripts/probes/`. Every deferral
  in this changelog from v3.1.0 to v5.0.0 is a row.
- `bun scripts/goals.ts` lints the ledger in `make check`. It refuses probes that only check a
  file exists, echo or call `--help`; it lets only Param drop a goal, with a quote and a date; it
  fails a release whose phase still has an unproven goal; and every deferral after v5.0.0 must cite
  `(goal: id)`.
- `--run` prints each goal red or green. `--next` prints the first unproven goal and runs at
  SessionStart, so the next step survives a context reset.
- Spec 10's factory rows now run this ledger instead of their own stubs.

## v5.0.0

Any tracker, any agent, any sandbox, and a cockpit you can carry. Upgraders: nothing to change;
GitHub stays the default tracker, `claude` the default agent and `local` the default runtime.

- Trackers: `tracker.kind` takes `linear`, `plane`, `jira`, `clickup` and `asana`, each validated
  from one key table and built by `makeTracker`. A shared kit reads the token from `tokenEnv` per
  call and carries the runner's markers through trackers that drop HTML comments. `labeledBy` reads
  each vendor's history; a label renamed after it was added names no one, and ClickUp label triggers
  stay off unless `labelTrust: "creator"`. ClickUp and Asana check every task is in the configured
  List or project first. `docs/trackers.md` shows the config per kind.
- The label set is built from `LABEL`, a test fails on a key nothing uses, and the tracker contract
  runs `doctor --fix` against every adapter and expects each label exactly once.
- Agents: an `acp` preset drives any Agent Client Protocol server over stdio; read-only stages refuse
  every permission that is not a read, search or think.
- Routing: an agent's `models.small` runs a low-risk change of at most 3 files, `models.large` a
  high-risk or 11+ file one, and `model` the rest. A rebuild after a verify reject climbs one tier.
  Analytics shows what routing saved against each agent's large model. Haiku 5.5 is priced, and the
  Sonnet 5.5 cache read is fixed. Scope is read only from trusted comments.
- Machines: `machine.json` `capabilities` sends a `needs:<cap>` issue only to a machine that has it;
  the git claim still keeps a task one machine took from every other.
- Runtimes: a `codespaces` kind runs a step in a GitHub Codespace, with the token passed as
  `GH_TOKEN`, never on argv.
- Receipts: each run's acceptance verdict is signed as an in-toto Statement in a DSSE envelope
  (Ed25519, `FACTORY_RECEIPT_KEY`). `kaas-verify` (`verify/`, Rust) re-derives every proof, count
  and the "Not proven" list from the rows. Verify clears planted run files first and seals the head
  and each file's sha256; the receipt refuses on drift or a symlinked run dir.
- Workflows: `after: 4h` on a park edge puts a human on the loop. If no maintainer comments within
  that window of the runner's own park notice, the factory approves and says so. An outsider's
  comment neither holds nor moves the window.
- Scheduled workflows: `dependency-update` (weekly), `security-audit` (daily, every plan parks) and
  `flaky-tests` (weekly) ship in the library with their own `on: cron:`. A cron-filed issue runs the
  workflow that filed it.
- Cockpit: installs as an app (manifest, icon, service worker). The worker precaches only the public
  shell and never answers for `/api`, so no run data is stored on a device.
- Cockpit: the inbox opens with a weekly brief: runs started, shipped and failed in the last 7 days,
  what waits on you and for how long, and the 7-day spend. `/api/analytics` gains `week`.
- kaas-relay (`relay/`, std-only Rust): the dashboard publishes the inbox and the week to it when
  `FACTORY_RELAY_URL` and `FACTORY_RELAY_TOKEN` are set; the cockpit follows it with a separate
  read-only token, so a phone off the network still sees the inbox. Nothing travels back. The
  dashboard opens a fresh connection per publish, since Bun's pool reuses a socket the relay closed.
- `machine.json` `llmGateway` runs every agent stage on its own LiteLLM key, capped at the stage's
  `maxBudgetUsd` and revoked when the stage ends; the agent holds no provider key and never the
  master key (`FACTORY_LLM_GATEWAY_KEY`). Only the `claude` and `codex` presets can use it.
- With an `llmGateway`, the agent's env loses every other provider credential (OAuth, Bedrock, Vertex,
  `AWS_*`, `AZURE_*`), and an `agentRuntime` whose `allow` names a model API fails to load.
- An agent stage in the `agentRuntime` VM gets a working git: a mirror of the stage repo with the
  holdouts' blobs left out and no reachable remote, so no agent can read a holdout or push.
- `machine.json` `agentRuntime` names a `microsandbox` runtime that every agent stage on the machine
  runs in, with only plain `FACTORY_*` values in its env and its keys held by msb.
- Fix: `FACTORY_SLOTS` overrode all of `machine.json`, so setting it dropped the machine's
  `runtimes`. It now overrides only `slots`.
- A `microsandbox` runtime: a gate or `check` step runs in a fresh microVM through `msb`, with egress
  denied except to the hosts in `allow`, and each key in `secrets` held outside the VM and sent only to
  its own hosts. `machine.json` fails to load when a secret's host is not in `allow`.
- An `agent37` runtime: a gate or `check` step runs on an agent37.com instance named in
  `machine.json`, with the key read from the env var `tokenEnv`. Exec bodies are capped at 128 KB, so
  the worktree goes over in base64 chunks, is unpacked in a fresh directory and removed after. It can
  be a `pool` member next to `http`.
- Fix: a `pool` member's minutes are held in `FACTORY_HOME/machine.db` before a run starts, in one
  transaction, and the run is cut off at what it holds. Two runs at once could each see the same
  minutes left and together run past the allowance. A pool can name its `fallback` (default `local`)
  or `"none"`, which fails the step instead of running it on this machine.
- A `pool` runtime: hosted sandboxes on free tiers in order, each with its monthly minutes from
  `machine.json`. A spent member is skipped, a run is cut off at the minutes a member has left, a
  member that fails as a runtime hands the run to the next one, and `local` runs it when all are
  spent. `factory pool` shows each member's minutes used and left and its last failure. An
  `ExecResult` now says `runtimeFailed` when the runtime, not the command, failed.
- The cockpit follows the kaas.team design: its tokens are a line-for-line copy of kaas.team's
  `:root` block, set in Geist, in one light theme, laid out like kaas-tasks: a sidebar with a Repos
  section that filters every view, and the view in an inset panel under a breadcrumb. The Line is the
  home page: a headline says what the inbox needs from you, then the issues with status icons and
  stage bars, repo cards and recent activity. The Line marks only the stage waiting on you in yellow.
  The theme switch, Inter, Inconsolata and `make tokens` are gone.
- Fix: a `?repo=` value from the dashboard URL can no longer name a path outside `FACTORY_HOME`.
- Fix: an agent no longer sees a tracker token or a named secret. Every env var a config names in a
  `tokenEnv`, `...SecretEnv` or `...KeyEnv` key, in the config or the machine config, is dropped from
  the agent's environment, whatever its preset keeps.
- Fix: an ACP agent in a read-only stage can no longer edit by mislabelling the tool. The bridge also
  compares the worktree by content hash before and after, once the agent's whole process group has
  exited, and fails the stage if a file changed. It detects a write after the fact; it is not a
  read-only mount.
- Fix: a `factory-data:` footer is decoded only on a comment or issue the runner's own tracker user
  wrote, and only when its HMAC, keyed by the tracker token and bound to the field (comment or
  description), holds. Anyone else's footer reaches the
  agent as written, so it cannot hide text from the humans. Rotating the token turns old footers
  back into their visible text.
- CI: `make check` keeps the runner's Rust toolchain reachable under its throwaway `HOME`.

Not in this release:

- Approvals from the phone: the relay is read-only, so unblocking and approving stay on GitHub or the
  dashboard.
- A stale-PR nudge (the code host's PR record has no `updatedAt` yet) and a PNG touch icon for iOS.
- The native tracker adapters are tested against fixtures modeled on each vendor's documented API,
  not against live workspaces.
- A read-only mount for ACP stages. An agent process that leaves its process group can still write
  after the check; run read-only stages in a sandbox runtime where that matters.
- A footer seal bound to the issue. One runner-written description pasted into another still
  decodes, since a description is sealed before the tracker gives it an id.

## v4.0.3

- Fix: `mutate.sh` runs each mutation in a detached git worktree of HEAD, with `TMPDIR` outside it.
  The old archive copy had no history and no common git dir, so tests that read git history, find a
  sibling checkout or check a path lies outside the repo failed on baseline, and every mutation came
  back baseline-red.
- New: a test gate may set `fileCmd`, the runner `mutate.sh` uses with named test files, for a gate
  whose `cmd` ignores file arguments (`make check`).
- Fix: a parked run whose PR a human merged now ships, and a parked run whose issue was closed
  outside the factory is ended on the next poll (shipped if its PR merged, else cancelled). Before,
  both stayed parked with their tmux window open.
- Fix: a merged PR removes the issue workspace, as a cancel already did. The branch keeps the work.

## v4.0.2

- Fix: each card leaves the watcher's in-flight set when its own run ends, so an approved card no
  longer waits for the slowest card started in the same poll. A poll whose issue list predates a
  card's release skips that card instead of starting it twice (#56).

## v4.0.1

- Fix: a card parked on a question now resumes when the operator answers, even if the agent left the
  `<!-- factory:question v1 -->` line out of its question. The runner's own `factory:data` question
  marker counts too (#54).

## v4.0.0

Events, minions, and trackers other than GitHub. Upgraders: nothing to change; GitHub stays the default
tracker and no events are sent until `events.sinks` is set.

- Events: every run emits CloudEvents 1.0 (`factory.step.started`, `factory.pr.opened`, `factory.pr.merged`,
  and the rest of the catalogue in `src/core/event.ts`). Config `events.sinks` posts them, signed with
  `x-kaas-signature: sha256=<hmac>`, from a SQLite outbox with retries; a delivery is dead after 8 attempts.
  `docs/events.md`.
- Inbound `POST /events` (HMAC, deduped on id; off until `FACTORY_EVENTS_SECRET` is set). An inbound event
  only wakes the poll, which applies the usual trust, pause and spend checks. Nothing is read from event data
  to pick an issue or an actor.
- Workflows take `on: { event: <type> }`.
- Minions: `.factory/minions/<name>.yml`, small jobs with no issue and no PR, run on an event or a cron.
  They run with triage's tools and only the MCP servers they name, count against the same daily caps, and
  see event data fenced as untrusted. `factory minion list|run`, `factory events tail|replay`.
- Trackers: `ScmPort` is now `TrackerPort` and `CodeHostPort`. Config `tracker: { kind: "http", url, tokenEnv }`
  takes issues from any tracker speaking Tracker API v1 (`docs/tracker-api.md`); PRs stay on GitHub and link
  back by head branch `factory/issue-<n>`. Config `labels` maps factory labels to a team's own names.
  `factory doctor` checks the tracker.
- One resolver builds the tracker and code host from config (`src/scm.ts`); no command constructs GitHub directly.

Not in this release:

- Connectors catalogue and a deterministic tool step (v4.2), org mode (v4.3), `factory teach` (v4.4),
  kaas.team look for the dashboard (v4.5).
- Minions run locally only, in an empty workspace (no repo checkout). No dashboard view for minions or events.
- `factory events tail --follow`.

## v3.5.0

The dashboard restyled on the lwp-deck palette, with two new pages. Upgraders: nothing to change.
Start the dashboard with `--repo-dir` (`factory up` already does) to fill the new pages.

- Colour comes from one place: `dashboard/design/tokens.json` (lwp-deck's palette) and the roles in
  `dashboard/tokens.ts`. `make tokens` writes `dashboard/public/tokens.css`. `make check` fails when a
  pair the page renders misses its WCAG level in either theme, when `tokens.css` is stale, when any
  other file in `dashboard/public` holds a colour literal, or when the page uses an undefined
  `var(--x)`.
- Light and dark themes: the system setting by default, and the Theme toggle overrides it.
- Inter and Inconsolata, self-hosted under the SIL Open Font License, replace Manrope.
- Workflows page: every workflow the repo can run, where it comes from, the issue types routed to it,
  its steps and its cron schedule, with the `factory harness validate` result on top. It is built
  from the same report as the CLI command.
- Settings page: slots and the daily cap from `machine.json`, each runtime with its kind, target and
  the config or workflow steps that use it, and the issue leases on the remote with their holder and
  expiry. A remote the dashboard cannot read says so instead of showing no leases.
- The mobile nav scrolls sideways instead of wrapping.

Not in this release:

- A form editor that writes a workflow's YAML through a PR; the Workflows page is read-only.
- An Events page with replay.
- A live health probe per runtime; the Runtimes table shows configuration only.
- Machine slot usage on the Settings page (slots are local; only issue leases are shown).
- Settings tabs; the page is one section per topic.

## v3.4.0

Any repo, any stack. Upgraders: nothing to change. A gate with no `role` still runs; give your test
gate `"role": "test"` so the proof can find it.

- Gate roles: `role` on a gate (`test`, `typecheck`, `lint`, `build`). The proof runs the `test`
  gate. A repo with no test gate records `proof: unavailable` in the PR summary instead of skipping
  silently. A repo with no gates at all parks each issue before build with "add a gate".
- `factory init`: reads the repo's own files (Bun, npm, pnpm, yarn, uv, poetry, pip, Go, Ruby and
  Rails, Rust, a Makefile `check` target) and writes `.factory/config.json` gates, setup and the
  commands build and verify may run. It installs the template first if it is missing, leaves a
  filled-in config alone unless `--force`, and `--pr` opens the change as one pull request.
- Monorepos: `packages` in config gives each path its own gates. Only the packages the diff touches
  run, plus any marked `always`; a diff that touches none runs them all.
- `factory scan` uses `osv-scanner` for any lockfile and falls back to `bun audit`. The CI scan job
  installs a pinned, checksummed `osv-scanner`, so it is no longer Bun only.
- `FACTORY_PORT`: each worktree gets its own free port, kept for its life, in the agent's env and the
  gates', so two builds of an app that binds a port do not collide.
- Workflow library: `bug-to-pr`, `docs-to-pr` and `approved-plan-to-pr` ship next to
  `feature-to-pr`. `routes.<type>.workflow` runs an issue type on its own workflow, recorded on the
  thread at pickup so resume, recovery and cron follow it. See [docs/workflows.md](docs/workflows.md).
- `factory harness validate` loads every workflow the repo has or names and exits 4 on a problem;
  `factory harness inventory` lists each one's steps, cron triggers and routed types.

Not in this release:

- Per-package owners and protected paths; `packages` gives gates only.
- The proof in a monorepo runs only the top-level `test` gate, not a package's.
- A workflow is chosen from the type label an issue was filed with; a type triage assigns later does
  not switch it.
- Library workflows that need new step types: pr-review, test-authoring, coverage-gap, flaky-test,
  dependency-update, ci-fix, ci-cd-authoring, release-notes, harness-learn, ui-component,
  spec-to-plan and backlog-triage.
- `factory harness scaffold` and `eval`.
- Per-language Docker images and devcontainer support for the docker and ssh runtimes.
- Concrete `scaleup` and `enterprise` profile rules (CODEOWNERS approvers, org caps, forced sandbox).
- A `toolchain` config key, and `factory init` writing `charter.md`.

## v3.3.0

Remote and async execution, with GitHub as the store that every worker shares. Upgraders: nothing
to change. The first stage that finishes creates one `factory:ledger` issue in the repo; leave it
open.

- Runtimes: `runtime.gates` and `runtime.check` in config, and `runtime:` on a `check` step, run
  those commands on a named runtime:
  - `local`;
  - `docker` (read-only, no capabilities, capped, no network by default; gVisor via `runtime`);
  - `ssh` (rsync, then run on the host);
  - `lwpr`;
  - `wrap` (any launcher, such as a Firecracker microVM, podman or nsjail);
  - `http` (a hosted sandbox behind a small JSON protocol, with a reference server).

  `FACTORY_HOME/machine.json` `runtimes` defines them. See [docs/runtimes.md](docs/runtimes.md).
- Leases: a worker takes `refs/factory/lease/<issue>` on the remote before it walks an issue's
  steps, and renews it every 10 s. Others reclaim it 30 s after it lapses. The push is a
  fast-forward-only compare-and-swap, so two racing workers cannot both hold an issue.
- Spend on GitHub: every stage's cost goes to its worker's marker comment on the issue and its
  daily comment on the `factory:ledger` issue. Caps read the larger of that and the local cache, so
  a second machine or a CI job sees the same totals, and a lost write never lifts a cap.
- `factory daemon install|uninstall`: `factory up` at login, restarted on exit, as a launchd agent
  or a systemd user unit. It holds no secrets.
- CI template:
  - actions are pinned to commit SHAs (a test enforces this);
  - checkouts fetch full history;
  - a comment or review on a PR runs the issue that PR works on (`factory run --pr N`), and
    `pull_request_review` is a trigger;
  - event data reaches scripts only through env.

Not in this release:

- Agent steps (triage, plan, build, verify, pr) on a remote runtime; they run where the factory
  runs. Only gates and `check` steps move.
- The `ssh`, `wrap` and `http` runtimes are tested against stand-ins and a reference server, not
  against a live VM, a Firecracker host or a hosted sandbox vendor.
- A Claude Code cloud routine that runs `factory tick` on a schedule, and `factory dispatch` driving
  the Actions template one step per job.
- A health probe per runtime in `factory doctor`; it checks names, not reachability.
- Transcripts and artifacts to a shared blob store; they stay on the machine that ran the stage.
- Cron dedupe through GitHub: two watchers could each still file one scheduled issue.

## v3.2.0

Triggers, intake trust, company-size profiles and per-step MCP servers. Upgraders: a
`factory:ready` label or a `/factory` command from someone without write access no longer starts
anything; check that whoever drives the factory has write, maintain or admin on the repo.

- `on: cron` in a workflow files a `factory:ready` issue at each matching minute (5 fields, an IANA
  `tz`, UTC by default), catches up to 60 minutes after a missed poll, and files nothing while the
  last one from the same trigger is open. See [docs/workflows.md](docs/workflows.md).
- `POST /webhook/github` checks the `X-Hub-Signature-256` HMAC against `FACTORY_WEBHOOK_SECRET`
  before reading anything, records one row per delivery id (bodies capped at 1 MiB) and wakes the
  watcher at once. With no secret the route is 404 and the poll runs as before.
- Intake trust: `factory:ready` counts only when the person who applied it has write, maintain or
  admin; otherwise the label comes off with a comment. `/factory` commands, including `cancel`,
  need the same role. Roles are cached for five minutes.
- `profile`: `solo`, `team`, `startup`, `scaleup` or `enterprise` sets plan auto-approval, the open
  PR cap and the merge policy; explicit keys still win. `riskPolicy.autoApproveMaxRisk` (`low` or
  `medium`) is the highest plan risk that auto-approves, and the bundled `feature-to-pr` plan edge
  reads it.
- `mcp:` on a step names servers from the base branch's `.factory/mcp.json` (never the issue
  worktree's, which an agent can write); that step's claude run loads only those
  (`--mcp-config` with `--strict-mcp-config`) and may use their tools. A missing name fails the
  issue before the step runs, and `factory doctor` checks every name.
- The clone pushes through `gh`'s credential helper, so a headless run never waits on a keychain
  dialog.

Not in this release:

- `emit` chaining between workflows, and a `labels:` mapping for a team's own label names.
- Checks API progress (one check run per step).
- The MCP notifier and event-source adapters, and `action: mcp`; the inbox chat channel stays a stub.
- Cron dedupe through GitHub, so two watchers on one repo could each file the same scheduled issue
  (v3.3, with the GitHub store).
- Per-team back-pressure and org caps for `scaleup` and `enterprise` (v3.4).
- Raising the plan's risk from a deterministic rating when the agent rates it lower.
- `src/revision.ts` and `src/derive.ts` still take a revision's or answer's text from any
  `COLLABORATOR` comment; only the command itself is role-checked.

## v3.1.0

The pipeline is a YAML workflow, and the runner is split into a pure core, ports and adapters.
Upgraders: nothing to change; with no `.factory/workflows/` the runner's own `feature-to-pr` runs,
and it reproduces v3.0.1 step for step (`tests/scenarios.test.ts` drives every branch through it).

- `.factory/workflows/<name>.yml` and `config.workflow` (default `feature-to-pr`): steps of the
  built-in types `triage`, `plan`, `build`, `verify`, `pr` and the new `check` (a shell command;
  red parks the issue as failed), each with its label and its edges. An edge can carry an `if:`
  (`plan.risk == 'low' && toggles.autoApproveLowRisk`) or park for approval. See
  [docs/workflows.md](docs/workflows.md). `driveFromStage` is gone; `src/engine/runner.ts` walks the
  workflow, and approve, revise and retry follow its edges.
- A broken workflow stops `factory watch` at boot with every problem listed; `factory doctor`
  checks the configured one, and `doctor --fix` creates any step label the factory does not ship.
- `src/core/` (the workflow parser and the `if:` language, no I/O), `src/ports/` (`ScmPort`,
  `Executor`, `GateRunner`, `ExecutionPort`) and `src/adapters/local/` (shell commands).
  `tests/hexagon.test.ts` enforces the import rules: core imports only core, ports only core and
  ports, no adapter imports another, and the engine never imports an adapter.
  `tests/adapters.test.ts` fails on an adapter directory that does not run its port's contract
  suite (`tests/ports/execution.contract.ts`).
- GitHub Enterprise: `GH_HOST` (the variable `gh` reads) sets the host for clone URLs and for
  reading `origin`.
- A rebuild after a reject resumes the last build session (`claude --resume <id> --fork-session`)
  and is told the last 12 KiB of why it came back: the verifier's comment, the red gate line or the
  failed holdout output. Agents that keep no session start fresh, as before.

Not in this release:

- `StorePort`, `SecretsPort`, `NotifierPort` and `EventSourcePort` land with their adapters in
  v3.2 and v3.3; `ExecutionPort` is a single `run` until the remote runtimes need
  prepare, collect and teardown (v3.3).
- `src/state.ts` and `src/agents/` stay where they are; the non-Claude presets move to
  `contrib/agents` later.
- `--json-schema` does not replace the stop-artifact hook: it constrains only the final message,
  and the hook checks the artifact files.
- The dashboard board has no column for a custom step label; such an issue shows in the list only.
- A rebuild only resumes for the claude preset; the failure tail is not yet in other agents'
  prompts.

## v3.0.1

Cleanup before the v3.1 engine. Upgraders: re-run `install.sh --update` to get `.factory/manifest.json`.

- A stage stops the moment Claude's `init` event reports a failed MCP server, a `plugin_errors` entry
  or a `mcp_server_errors` entry (`agent startup failed: ...`), instead of running without the tools
  it expected.
- Claude stage runs set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- `install.sh` writes `.factory/manifest.json` (the sha256 of every factory file it left in place),
  and `factory doctor` warns about each one edited since, unless `templateOverrides` lists it.
- Auto-merge judges the PR head commit, not the worktree's `HEAD`, and refuses an executable, a
  symlink, a submodule or a binary file. A rename counts as a delete plus an add, so moving a file
  out of a protected path is caught.
- A retro proposes one change: a lesson with a skill edit, or a `skill_name` without its
  `skill_edit`, fails validation.
- A test pins `.factory/memory/lessons.md` as runner-only: `guard-paths.sh` refuses a stage's edit,
  and only `factory learn` writes it, through a PR.
- Pricing for `claude-sonnet-5-5` and `claude-fable-5-1`; `claude-haiku-5-5` stays unpriced because
  its rate is tiered by prompt size. The example config's sonnet agent uses `claude-sonnet-5-5`.
- The CLI's code moved to `src/cli.ts` (`bin/factory` is a shim), so `tsc` checks it directly.
- `.config/wt.toml`: a worktrunk worktree of the factory gets its own `FACTORY_HOME`, dashboard port
  and machine caps in `.factory-wt.env`, so a live loop there shares nothing with another run.
- `.github/CODEOWNERS`; the README points at `docs/agents.md` for which agents are verified.

## v3.0.0

The token diet: each stage gets only what it reads. Breaking for upgraders: re-run
`install.sh --update`, then reconcile `.claude/settings.json.factory-new` (the verifier evidence hook
moved from SubagentStop to Stop).

Prompt bytes per stage on the splitbill-demo fixture (`--append-system-prompt` plus the stage skill
and the references it always reads), v2.12.3 to v3.0.0: triage 10,164 to 5,971, plan 10,611 to
7,330, build 10,739 to 10,566, verify 14,519 to 6,769, pr 9,175 to 3,198, retro 8,721 to 2,724.
Total 63,929 to 36,558 (43% fewer). `tests/token-budget.test.ts` pins each stage about 10% above.

Live, on the same splitbill-demo bug (Claude only, all five stages, shipped): v2.12.3 on #88 against
v3.0.0 on #97. Input tokens here count cache reads and writes and every subagent (`modelUsage`).

| stage | v2.12.3 | v3.0.0 |
|---|---|---|
| triage | 80k, $0.216 | 60k, $0.086 |
| plan | 106k, $0.197 | 115k, $0.249 |
| build | 252k, $0.306 | 307k, $0.364 |
| verify | 245k, $0.360 | 169k, $0.330 |
| pr | 87k, $0.162 | 79k, $0.091 |
| total | 770,241, $1.2412 | 729,722, $1.1206 |

That is 5% fewer input tokens and 10% less spend, short of the 40% target. Prompt bytes are a small
share of a stage's input: each turn re-reads the whole context, so turns times context size drives
it, and about 20k tokens per session is Claude Code's own system prompt. Build ran 18 turns against
13 and is the next target (v3.1's resumed retries and `--json-schema` both cut turns).

- **AGENTS.md loads once.** CLAUDE.md already imports it, so the context pack no longer copies it in.
  pr and retro get the artifacts only (`STAGE_PACK` in `src/context.ts`), and the skills index is
  frontmatter only.
- **The runner proves the build, not a model.** The `factory-verifier` subagent is gone. Under
  `proof: test`, `src/proof.ts` restores every non-test file from the merge base, runs the `test`
  gate, restores HEAD and writes `proof.json` (`bites`, `passes-without`, `no-tests` or `skipped`,
  with the output tail) before verify starts. Verify judges the tail and proves by hand from
  `references/prove.md` only when the runner could not. On #97 it recorded `bites`: two new CSV
  tests failed with `src/csv.ts` reverted. `stop-verifier-evidence.sh` now runs on the verify Stop.
- **Verify waits for its reviewer.** `guard-paths.sh` refuses a backgrounded subagent inside a
  stage. On #95 verify backgrounded `factory-reviewer`, waited, and ran 17 turns; on #97, 8.
- **Each stage loads only the tools it uses** (`STAGE_TOOLS`, passed as `--tools`): Bash, Read,
  Write and Skill, plus Edit for build and verify and Agent for plan and verify. Before, every stage
  loaded 13, including WebSearch, NotebookEdit and DesignSync.
- **Plan researches through the built-in Explore agent.** `factory-explorer` is gone.
- **Recheck without a model call.** `DiffAnchorRechecker` drops a finding whose `where` is not on a
  line the diff changed. The `claude -p` pass over the whole diff is gone.
- **Per-stage model and effort.** triage, pr and retro run `--model sonnet --effort low` unless the
  agent config names a model. plan, build and verify keep the CLI default.
- **`install.sh --update` removes retired files** (`factory-verifier.md`, `factory-explorer.md`), so a
  retired agent stops costing every stage its description.

Moved to v3.1: build retries that `--resume` the session (a CI runner cannot resume a machine-local
session, so it needs the engine's `on_fail` fallback), and `--json-schema` in place of the
stop-artifact hook.

## v2.12.3

Walk through a finished run without running it.

- **The dashboard reads artifacts from the repo's own workspaces.** `factory dashboard --repo` looked in
  the legacy `$FACTORY_HOME/workspaces`, so an issue's artifacts listed nothing.
  `createDashboard` now defaults to `workspacesDir(env, repo)`, the path the watcher writes.
- **`teach/demo/lightning-2.sh snapshot [dir]` and `replay [dir]`.** `snapshot` saves the state DB and
  every issue's stage artifacts as a small `FACTORY_HOME` before a reset wipes them. `replay` serves the
  dashboard on it, on port 4101 by default. `teach/lightning-2.md` section 8 is the walkthrough.

## v2.12.2

Four things the Lightning-2 run on v2.12.0 showed wrong on screen, and the Claude pin.

- **The PR's run summary shows the verify verdict.** `stage_runs` gains a `verdict` column
  (forward-only migration), stamped once `verdict.json` is read. A verify row reads `pass`, `reject` or
  `uncertain` instead of `ok`, and only `pass` counts as a first-try success.
- **The inbox says why an issue parked.** A `needs-human` or `failed` item leads with the runner's
  own reason (`runs.reason`), such as "verify uncertain", instead of the latest factory comment, which
  could be the plan. Both `factory inbox` and the dashboard read it.
- **The Line view fills a stage that ended ok before a park.** A triage that refused an issue, or a
  plan awaiting approval, shows its block as done, and the row shows the park reason. A verify whose
  verdict was not `pass` shows as failed. The block logic moved to `dashboard/public/lib/stations.js`
  so `tests/stations.test.ts` covers it.
- **`factory takeover` says how to pass Claude's folder-trust prompt.** A fresh worktree is a folder
  Claude has not seen. The runner does not edit `~/.claude.json` to skip the prompt; it prints
  "choose Yes" before it hands over the terminal.
- **Claude Code pin: 2.1.281 to 2.1.286** in the Dockerfile, CI template, preset and
  `docs/agents.md`. `tests/agents-registry.test.ts` already holds the copies equal.

## v2.12.1

Fixes a spend loop and an ignored revise, both found in the Lightning-2 rehearsal on v2.12.0.

- **A `/factory retry` runs once (`src/watch.ts`).** A parked issue resumed on its latest human
  comment. When verify came back uncertain it parked without a comment, so the same retry stayed
  latest and rebuilt the issue on every poll. The runner now acknowledges a retry with a
  "Retrying from <stage>" comment, and a retry only counts when it is newer than the runner's last
  comment. Scenario 10d covers it.
- **An uncertain verdict is posted.** It used to be posted only after a re-check, so the issue
  parked at `needs-human` with nothing on GitHub saying why.
- **Build reads a PR revise (`factory-build` skill).** `/factory revise <text>` on a PR wrote
  `revise.md` and reran build, but only the plan skill read that file, so build saw a finished plan
  and changed nothing. A test in `tests/skills.test.ts` checks that every stage a revise reruns
  reads `revise.md`. Run `factory install --update` to pick up the skill.

## v2.12.0

Watch every task live and step in when one needs a human: each stage streams to a transcript, tmux
shows one window per issue, `factory takeover` opens the agent's own session in the worktree and
hands the issue back on exit, and every PR says how its run went. Also ships #18 to #21, which
merged after v2.11.0 without a release.

- **Live transcript (`src/agents/executor.ts`, `src/paths.ts`).** Every stage appends one line per
  event to `$FACTORY_HOME/<owner>/<name>/transcripts/issue-N.log` while it runs (a preset-less agent
  gets its raw output), and writes `live/issue-N.json` with its pid and session while it runs. Both
  are best effort: a write error never fails a stage.
- **tmux view (`src/tmux.ts`).** `"tmux": { "enabled": true, "session": "factory" }` or `--tmux` on
  `watch`/`up` opens a window per issue tailing its transcript, and closes it when the run ships,
  fails or is cancelled (a parked issue keeps its window). `watch` and `up` refuse to start when it
  is enabled and `tmux -V` fails, and `doctor` checks the same. `factory up --tmux` puts the watcher
  and the dashboard in windows of their own; `factory attach [N]` joins the session, locally, over
  `ssh -t` or through `docker exec -it`. The Docker image and CI install tmux.
- **`factory takeover N` (`src/takeover.ts`).** Stops the running stage with a marker so the
  executor reports `operator takeover`; `runFromStage` parks it `needs-human` with a `takeover` data
  marker, which is neither a failure nor a retry, and `deriveIssueState` resumes at that stage. It
  then runs `claude --resume <session>` in the worktree and posts `/factory retry` on exit
  (`--no-handback` skips that). With nothing running it opens the last recorded session.
- **Behaviour change: Claude sessions persist.** `claudeArgs` no longer passes
  `--no-session-persistence`, so each stage's session is kept in `~/.claude/projects` and its id is
  stored in the new `stage_runs.session_id` column (forward-only add-column migration). The tool-free
  re-check in `src/recheck.ts` still runs without persistence.
- **PR "Factory run" section (`src/run-summary.ts`).** The PR body ends with a table of every stage
  run (agent, duration, tool calls, cost, outcome) and two lists, "Went well" and "Needed help"
  (reruns, takeovers, kills, verify rejections, retries), all read from `stage_runs` and the thread.
  `"prRunSummary": false` turns it off.
- **`doctor`: `templateOverrides`.** The installed-skills drift check skips the files or directories
  a repo lists as customised on purpose, so a deliberate edit stops reading as drift.
- **`verify-agent` writes fixtures to the runner's tree** (`defaultFixtureDir`), not the current
  directory, which had left a stray fixture in splitbill-demo.
- **`teach/demo/lightning-2.sh up` refuses when the dashboard port is taken** and names the process
  holding it, instead of a "port in use" error inside a pane.
- **Shipped from main:** a blocker gate, so ready issues wait on their "Blocked by" line (#18); a ui
  route's visual verify (#19); the gate tree hash keeps hidden holdout files, so verify trusts fresh
  evidence (#21); the lightning-2 walkthrough and `teach/demo/lightning-2.sh` (#20).

Not in v2.12.0:
- A free port per worktree for gates that bind one (`FACTORY_PORT`): no gate binds a port today.
- Updating an open PR's run summary after a revise; the section is written when the PR opens.
- Resuming a non-Claude agent's session, and uploading transcripts or recordings anywhere.

## v2.11.0

Ready for "Build a Claude Code Verification Harness": holdout tests give the Doer-and-Tester
loop a check the builder's own `gates.sh` cannot have been tuned to pass, and two install-time
gaps found in an audit of a live second repo (lwp-website) are closed before they can break one.

- **`src/holdout.ts`: holdout tests.** `holdout: { paths: [...], cmd: "..." }` in config, off by
  default (`holdoutEnabled` reads it off an empty `cmd`). `Git.excludeFromSparseCheckout`
  (`src/git.ts`, non-cone sparse-checkout) hides the configured paths from every stage's worktree
  from the moment `ensureWorktreeReady` creates it, so no agent (Claude, Codex or Cursor alike)
  ever reads them. Verify runs them against a scratch copy assembled from `git archive HEAD` with
  the holdout paths force-overlaid from `origin/<base>` (defense in depth if one ever reached HEAD
  altered), and rejects on failure with only the truncated stdout/stderr, never source, feeding the
  existing reject-and-rebuild loop (`MAX_VERIFY_REJECTS`) so a failing holdout escalates to
  `factory:needs-human` with a `gave-up` retro the same way an AI-verifier reject does. Holdout
  paths are also merged into the pre-push protected-path diff check, so a build that creates or
  edits one is refused regardless of how it did it. `factory-verify/SKILL.md` notes that holdout
  results are the runner's; the skill itself never reads the paths.
- **`src/doctor.ts`: the baseline-tag check is gated on `config.resettable`.** A repo that never
  opts into `reset`/`rebaseline` (lwp-website, which must never be reset) has no reason to keep a
  `baseline` tag current, and previously failed doctor for a tag it could never use.
- **`bin/factory install`: labels are created right after a real install**, calling the existing
  `fixDoctor` (labels resolver: `labelsFor` in `src/labels.ts`, already used by `doctor --fix` and
  `reset`) instead of leaving a fresh repo with no `factory:*` labels until someone remembers to run
  `doctor --fix` first. Skipped on `--dry-run`; best-effort on a fresh clone with no filled-in
  `config.json` yet.

Not in v2.11.0:
- `bin/factory` itself typechecked: `tsconfig.json` lists `bin` under `include`, but the file has no
  `.ts` extension, so `tsc --noEmit` silently skips it (confirmed by planting a type error in it and
  seeing `tsc` exit 0). Pre-existing, not introduced here; fixing it means either renaming the
  entrypoint or adding an extension-less override, both out of scope for this release.
- A holdout test actually written for any real repo: this release ships the mechanism, off by
  default. splitbill-demo gets its first holdout test in the next release.
- Live Codex/Cursor cross-agent verification: unrelated to holdout itself, tracked separately.

## v2.10.0

Memory across runs. A run's lessons now survive it: a read-only retro stage proposes at
most one lesson or skill edit after an issue's final outcome, and `factory learn` batches
whatever's pending into a PR you review, never merges automatically.

- **`research/agents/claude/memory.md`.** Headless Claude's own auto-memory writes to a
  path keyed by a hash of the worktree's absolute directory, under the operator's home
  directory: operator-machine-local state, gone once a worktree is torn down, invisible in
  CI, and never shared across machines. Confirms the roadmap's pre-decided design: the
  factory never relies on `~/.claude`.
- **`src/context.ts`: repo-local memory.** `.factory/memory/lessons.md` is capped at 8 KiB
  (`MAX_LESSONS_BYTES`), keeping the most recent lines and dropping the oldest when it
  would grow past the cap, and is injected into every stage's context pack the same way on
  the Mac, a VPS or in CI.
- **`src/watch.ts`: a retro stage after each final outcome** (merged, rejected by you, or
  given up on after the third verify rejection past `MAX_VERIFY_REJECTS`), plus a fourth
  trigger from the dashboard's operator-merge route, which queues the retro for `pollOnce`
  to drain since it has no `Executor` of its own to run it. `runRetro` never goes through
  `runStage`'s `upsertRun` (an already-terminal run would be put back to "running"), but
  its cost still rolls into spend-cap accounting through the same `recordStageRun` call.
  Read-only, on Haiku by default; it proposes at most one lesson or skill edit, or none
  (neo's rule of at most one task per review, idea only, no code copied), and writes a
  `retro.json` artifact linking the run.
- **`src/learn.ts`: `factory learn`.** A deterministic, non-agent command that batches
  every pending retro proposal into `.factory/memory/lessons.md` and per-skill
  `.claude/skills/<name>/PROPOSED_EDITS.md` files, commits, and diffs the branch against
  base before pushing. `outsideAllowedPaths` (`src/boundary.ts`) is the one exemption from
  `protectedPaths`, and only for a `factory/learning-YYYYMMDD` branch: it may touch
  `.factory/memory/**` and `.claude/skills/**`, nothing else. A row is marked learned only
  after its branch pushes and its PR exists, so a refusal or a crash first leaves it
  pending for the next run rather than dropping it. Idempotent per day: a second run
  reuses the same branch and PR. It never auto-merges, and shows in the dashboard inbox as
  its own read-only `learning-pr` kind, since it has no linked issue to chatops against.
- **`src/boundary.ts`: `touchesProtectedPath` now always refuses `.claude/**` and
  `.factory/**`, merged inside the function itself rather than at each call site.** A
  normal build's push check (`src/watch.ts`) relied entirely on the repo's own
  `protectedPaths`, which defaults to `[]`; `guard-paths.sh` already hardcoded both paths
  unconditionally for interactive edits, so a Bash-made edit outside that hook could still
  reach a push. Baking the merge into `touchesProtectedPath` itself, rather than patching
  the build-stage call site alone, also closes the same gap at `src/merge-policy.ts`'s
  `autoEligible`, a second call site the first fix missed.

Structural tests: a learning PR outside its allowed paths is refused before any push
(`tests/learn.test.ts`); the lessons file cap holds (`tests/context-pack.test.ts`); a
normal build still cannot touch `.claude/**` with the default empty `protectedPaths`
(`tests/scenarios.test.ts`), and neither can an auto-merge-eligible PR
(`tests/boundary.test.ts`, covering both `touchesProtectedPath` call sites at once).

Not in v2.10.0:
- A live run of the retro stage and `factory learn` against splitbill-demo: the
  currently-installed production `factory` predates this branch, so a genuine run needs a
  reset to a clean baseline first, the same category of blocker as v2.7.0's live run,
  pending your reset OK.
- Mutual-exclusion enforcement between a lesson and a skill edit on one retro row: the
  retro skill's own instructions say "propose at most one," but nothing in `src/schemas.ts`
  or `src/learn.ts` would refuse a row carrying both. Left as a prompt-level rule, since no
  run has produced one yet.

## v2.9.0

The review inbox stops sending you to GitHub. A PR waiting on you now shows its diff, gate
evidence, verify verdict, CI status and per-stage cost right in the dashboard, across every repo
the factory watches, with a merge button for the operator's own authority.

- **`src/merge-policy.ts`: an operator merge path.** `decideOperatorMerge(readiness, ci)` reuses
  `checkReadiness` with the PR's own base branch, skipping `autoEligible`'s risk/path/size gates
  entirely, since a human click is a different authority source than the `auto` policy. It shares
  one merge primitive, `attemptMerge`, with the automated policy (a spy test proves the same
  function serves both). `renderOperatorAuditComment` posts its own `**operator**` wording, kept
  distinct from `**auto**`/`**dry-run**` so the audit trail always shows who approved.
- **`src/github.ts`.** `prDiff` (`gh pr diff`) and `prForIssue`, the one open PR that closes an
  issue, shared by the triage check and the new review route. `mergeReadiness`'s
  `changesRequestedStale` flag: a CHANGES_REQUESTED review against a commit the head has since
  moved past no longer blocks the item, idea only, from assembler's unmerged fix branch, no code
  copied.
- **`src/paths.ts`: `discoverRepos(FACTORY_HOME)`.** Every `<owner>/<repo>/factory.db` under the
  factory's home directory becomes one inbox source, so a machine watching several repos gets one
  inbox with a repo filter, not one dashboard per repo.
- **`dashboard/server.ts`.** `GET /api/inbox` aggregates across every discovered repo (or filters
  to one with `?repo=`); `GET /api/issues/:n/review` returns the diff, CI, gate evidence, verify
  verdict and per-stage cost for the PR that closes an issue; `POST /api/issues/:n/merge` runs
  `decideOperatorMerge` and, on `outcome: "merge"`, calls the same `attemptMerge` the policy uses.
- **`dashboard/public/app.js`.** A repo filter on the inbox list; a review panel for `review-pr`
  and `merge-dry-run` items (diff, CI status, gate line, verify findings, a per-stage cost table);
  an "Approve and merge" button wired to the new merge route, separate from the generic
  approve/revise/cancel actions, since neither of those inbox kinds carries a server-side
  "approve" action.

Structural tests: every factory state or parked label yields one inbox item with at least one
action, or none for in-flight labels (`tests/inbox.test.ts`); one merge function serves both the
dashboard button and the automated policy (`tests/merge-policy-operator.test.ts`, a spy across
both call sites). Verified live against a real in-review PR
(`learnwithparam/splitbill-demo` issue #10 / PR #16): the review route returned the actual diff,
CI status, gate evidence and verify verdict from GitHub, unchanged from the fixture shape.
Playwright screenshots at 1440, 768 and 375 px in light and dark themes cover the inbox list, the
review panel and the repo filter, with no console or page errors at any size.

Not in v2.9.0:
- "Request changes" as its own review action: the existing `revise` action (with your note) fills
  this role; a separate action would duplicate it.
- A CHANGES_REQUESTED-superseded check on the operator merge path beyond what `mergeReadiness`
  already reports: `changesRequestedStale` is read, not re-derived, by `decideOperatorMerge`.
- Any change to the automated `merge.policy` behavior from v2.8.0: this release only adds a
  second, human-triggered caller of the same merge primitive.

## v2.8.0

The merge-policy half of the lwp-website pilot: the factory can now tell whether an in-review PR
is safe to merge on its own, and — only when a repo opts in — merge it. Merging stays "off" by
default; nothing here changes behavior for a repo that doesn't set `merge.policy`.

- **`src/ci.ts`.** `validatePr` and the CI half of the pipeline (ported from machinist
  `agent.py:439-459,487-592`): `waitForCi` polls a PR's checks until they finish or time out, and
  the new one-shot `ciStatusNow` takes a single snapshot instead — a non-blocking read for a poll
  loop that must never hold a worker slot. Both now share one `ciResultFrom` helper for the
  finished/passing logic, so that check is written once, not twice.
- **`src/merge-policy.ts`.** Ported from machinist `risk_delivery/gate.py`, with the
  herdr-issue-coordinator merge-gate checklist (`agent-skills@766699e`
  `skills/herdr-issue-coordinator/SKILL.md:209-226`) as its ten named refusal reasons.
  `merge.policy` is `"off"` (default), `"dry-run"` (assesses and posts an audit comment, never
  merges) or `"auto"` (merges once every gate holds). `auto` also needs `merge.autoPaths`,
  `maxFiles` and `maxLines` — a repo config allow-list in place of gate.py's hardcoded
  docs/README-only, 10-file, 200-line one, since a blog post is often longer than 200 lines.
  Authority is explicit only: no config, no merge. The merge itself always runs
  `gh pr merge --squash --match-head-commit`, never `--admin`, so a branch-protection block is
  still respected under `auto`. The audit comment carries a `<!-- factory:merge-policy:HEAD_SHA -->`
  marker, and a `dry-run` comment now gets its own `merge-dry-run` inbox kind instead of the
  generic `review-pr` one.
- **Wired into `resumeInReview`, not the pipeline's terminal "pr" stage.** `waitForCi`'s own wait
  can run up to 20 minutes; blocking a worker slot on it would undo v2.7.0's continuous dispatch.
  Instead `checkMergePolicy` runs once per poll — non-blocking, one CI snapshot, one readiness
  read — and skips entirely when `merge.policy` is `"off"`. A human `/factory revise` or
  `/factory cancel` on the same issue always wins over the merge check that poll.
- **`src/github.ts`:** `prStatus`, `mergeReadiness` (including unresolved review threads, which
  needs its own GraphQL call — neither `gh pr view` nor `gh pr checks` exposes it) and `mergePr`.
  **`src/git.ts`:** `diffStat`, the per-file added/deleted line counts `autoEligible` sizes a
  change by.

Structural tests: a spy across the whole scenario suite proves `merge` is never called on any
path while `policy` is `"off"`; `tests/merge-refusal-coverage.test.ts` regex-parses every member
of `MergeRefusalReason` out of `src/merge-policy.ts` and fails if any one of them isn't asserted
by name in `tests/ported/machinist/merge-policy.test.ts` (this caught a genuine pre-existing gap:
`draft` and `not-mergeable` had no test, now fixed); a file under `protectedPaths` never qualifies
for auto-merge whatever `autoPaths` says, both at the module level and at the scenario level.

Not in v2.8.0:
- The lwp-website-side scaffolding — `.factory/config.json`, `protectedPaths`, `charter.md`,
  issue forms, gate fixes, the copied writing/lwp-shared skills, the CI workflow — and the five
  pilot issues themselves. Separate PR, against `lwp-website`.
- gate.py's git-tree-truncation, file-mode and renamed-file checks: not ported, not needed by this
  codebase's diff shape.
- Waiting on a Codex review bot before merging: not ported: this pilot only reads GitHub's own
  review/CI state.
- The review inbox's own merge button (v2.9): the `merge-dry-run` inbox item is read-only for now.

## v2.7.0

Routing, concurrency and cost. The factory now picks a model per issue type and stage, shares
one machine's slots and daily budget across every repo it watches, and can prove non-test work
(a blog post, a docs page) without ever writing a failing test.

- **`routes` in `.factory/config.json`.** Each type label (`bug`, `feature`, `docs`, `security`,
  `dependency`, or one a repo adds, e.g. `content`) can name its own agent per stage and its own
  routed skills. `resolveRoute(agents, stages, routes, stage, type)` resolves
  `routes[type].stages[stage]` → `stages[stage]` → `stages.default` → `"claude"`; triage always
  uses `stages.triage`, since the type isn't known yet. `template/.factory/config.example.json`
  ships the recommended default: triage on Haiku, plan on Opus, build and verify on Sonnet, PR
  on Haiku, with `docs` builds on Haiku. With no config, the Claude CLI's own default model still
  applies.
- **`src/context.ts`: a context pack, built once per stage.** `buildContextPack(stage, issue, cwd,
  skills)` assembles AGENTS.md, the route's skills, `ARCHITECTURE.md` if the repo has one, and the
  files named in `plan.json`, capped at 64 KiB; whatever doesn't fit is named, never truncated
  mid-file. Claude gets it appended after `STAGE_GUIDANCE` on the same `--append-system-prompt`;
  every other agent gets it inlined ahead of the artifact contract in its rendered prompt.
- **Pricing for the current models.** `claude-sonnet-5` and `claude-opus-5-5` price correctly
  instead of costing NULL; `research/pricing/anthropic.md` captures the source table these prices
  (and the already-priced `claude-haiku-4-5`) come from.
- **Concurrency belongs to the machine, not the repo.** `src/machine.ts` reads slots from
  `FACTORY_SLOTS`, or `FACTORY_HOME/machine.json` (`{ "slots": N, "dailyUsd": N }`), validated at
  boot. A repo's own `concurrency` becomes a cap on top of that: the limit is whichever is
  smaller. Slots are leases in `machine.db` (`BEGIN IMMEDIATE`), reclaimed when a holder's pid has
  died, so two watchers on one machine (splitbill-demo and lwp-website) share one pool instead of
  each assuming the whole machine. `factory doctor` prints a suggested slot count from cores and
  free memory, as advice only.
- **Continuous dispatch.** The watcher no longer waits for the whole pool to drain before polling
  again; it keeps polling while jobs run and picks up new work the moment a slot frees, tracking
  in-flight issues so nothing double-starts.
- **Spend caps.** `spend.perIssueUsd` and `dailyUsd` (repo and machine) are checked before every
  stage, against the running sum of `stage_runs.cost_usd`. Over a cap, the issue parks with a
  "budget" inbox item and intake pauses while the daily cap is hit; a stage with unknown cost
  counts against a separate token cap so an unpriced model can't spend past every limit for free.
- **`proof: "test" | "check"` on the plan.** `test` (the default) keeps today's rule: build writes
  a failing test first, verify checks it catches the bug. `check` names the commands that prove
  each acceptance criterion instead: build runs them, verify re-runs them and judges the diff, and
  never asks for a test. Both skills read `proof` off the plan artifact, never off the type name, so
  a repo can declare work `proof: check` under any type, including one it added itself. The type
  list is config-driven everywhere now; `TYPE_LABELS` is the default, not the only list.

Structural tests: every `(type, stage)` pair in `routes` and `TYPE_LABELS` resolves to a defined
agent; `loadConfig` refuses at boot when a routed skill has no `SKILL.md` on disk, instead of
no-opping mid-run in the context pack; a `proof: check` plan (Markdown files, a prose-lint gate,
no test file) ships exactly like a `proof: test` plan; the app-agnostic grep now covers every
file under `template/.claude/skills` and `template/.claude/agents` for a named stack tool
(`npm`, `bun`, `pytest`, `cargo`, `go test`), since those are the files an agent actually reads at
runtime, unlike `gates.sh` or the CI workflow, which are allowed to be stack-specific; a property
test holds running jobs to the machine's slots across two watcher processes and confirms a freed
slot is picked up within one poll.

Not in v2.7.0:
- The lwp-website pilot itself, `merge.policy`, and anything that merges (v2.8).
- A live agent run against splitbill-demo exercising the new routes and concurrency: pending your
  reset OK.

## v2.6.2

Any repo, safely. No new features: this closes the gaps a second repo (splitbill-demo plus
lwp-website) hit under one shared `FACTORY_HOME`.

- **Per-repo state.** `factory.db` and `workspaces/issue-N` now live under
  `FACTORY_HOME/<owner>/<repo>/`, not one shared `FACTORY_HOME`; two repos each carrying an issue #3
  no longer collide on one worktree or one DB row set. `src/paths.ts` is the one resolver. `factory doctor`
  warns (never auto-fixes) when the pre-v2.6.2 shared `factory.db` or `workspaces/` is still on disk;
  moving that history is a deliberate, manual step, not something a doctor run does for you.
- **`resettable: true` opt-in.** `factory reset` and `rebaseline` now refuse on a repo that hasn't opted
  in; a live repo like lwp-website (which deploys on merge to `main`) can no longer have its issues and
  branches wiped by a config that was only ever meant for a sandbox.
- **The base branch defaults to `origin/HEAD`,** not a hard-coded `"main"`. A repo cloned with a
  non-`main` default (`trunk`, `develop`) gets the branch it actually has, unless a config names `base`
  explicitly. `factory-verify` and `factory-comment`'s skill text now say "the base branch" instead of
  quoting `main`.
- **A `setup` hook.** `.factory/config.json` can list `setup` commands (e.g. `npm ci`) that run once per
  worktree, before any stage; a failure parks the issue with the log attached, instead of every stage
  failing separately on a project that was never installed.
- **Issue forms and a PR template.** `install` now ships `.github/ISSUE_TEMPLATE/{bug,feature,docs}.yml`
  (each applies only its own type label, never `factory:ready`) and `.github/pull_request_template.md`
  (summary, plan, gate evidence, verify verdict, risk and rollback: the same sections `factory-pr`'s
  fallback body now uses when a target repo has no template of its own). `install.sh`'s next-step message
  now says `factory doctor --fix`, which is what actually creates the `factory:*` and type labels; it used
  to say plain `factory doctor`, which only reports them missing. This is what makes the
  `src/labels.ts:48` claim ("set by the issue form") true.
- **Carried over from v2.6.1:** the CI template gets a "set up your toolchain" placeholder step in
  `run-issue`, `tick` and `manual` (not `scan`, which only runs `bun audit`); `factory scan` skips with a
  clear message, never shelling out, on a repo with no `bun.lock`/`bun.lockb`; `teach/sessions.json` is
  renumbered to this roadmap's versions. The Agents table's `overflow-x: auto` wrapper already covered the
  375px-scroll item (verified, no change needed).

Not in v2.6.2:
- Model routing, machine concurrency, spend caps and `proof: check` for non-test work (v2.7).
- The lwp-website pilot itself, and anything that merges (v2.8).
- A live agent run: no stage's behavior changed here (only wording, config surface and file layout), so
  the last live Claude run (v2.6.1) still stands as current evidence.

## v2.6.1

Residue fixes for v2.6.0. No new features.

Corrections to v2.6.0:
- The doctor did not fail a custom agent that had no bypass flag; it does now, and `--version` has a timeout.
- The CI template did not install every preset or pass its keys; it does, and a test checks it.
- The Docker note "a build with two agents was run" had no recorded evidence. This release built the default image
  and ran `--version` in it: claude 2.1.281, codex 0.156.1, gemini 0.61.0, opencode 1.18.32, all equal to the pins.
- OpenCode and Pi were read as positional-only from their `--help`, but their docs show both take the prompt on
  stdin, so it stays on stdin. Each preset now names the doc line that shows how it takes the prompt
  (`promptVia`, `evidence`), and a test reads that line. Pi's skills dir is `.pi/skills`. OpenCode's read-only
  stages run `--agent plan`; Cursor's run `--mode plan`.
- A prompt passed as an argument (Cursor) over 120 KiB is refused with a clear error, not an E2BIG failure.
- Mastra Code has no `--version` (it reads it as a prompt); doctor skips the drift check for it. Its argv is
  built through flags ported from mastra under Apache-2.0 (`ee/` was not read).
- R11 was already covered: Codex gets `-s read-only` per stage, and a test pins it.

Fixes:
- A live Claude run on a fresh sandbox (`factory verify-agent claude`) passed all six stages in 281 s for $1.77;
  its build, verify and pr output is recorded in `tests/fixtures/agents/claude/`. The recorder now also scrubs
  Claude's dash-encoded home paths (`-Users-name-`), which it used to leave in.
- `teach/sessions.json` names immutable splitbill tags `checkpoint/<name>` instead of force-pushed branches.
- R10: `stage_runs.cost_usd` is nullable in old databases too; an unknown cost stays NULL, not $0.
- `factory reset` and `watch` act on the clone's origin. A config whose `repo` disagrees with origin is
  refused, and a missing `repo` is read from origin. Before this, a copied config could close and reseed
  issues on the wrong repo.
- `factory reset` creates labels before seeding issues, so it works on a fresh repo (found on the first sandbox reset).
- `factory reset` checks the baseline tag before closing anything, and closes only issues labelled
  `factory:*` or seeded from `.factory/issues`. `--all-issues` keeps the old behaviour for a sandbox.
- `tests/app-agnostic.test.ts`: runtime code never names the demo app outside comments, and a Python repo on
  a `trunk` branch loads, gates and refuses a wrong origin.
- The Agents page shows the installed version and doctor rows, and stages fall back to Claude like the executor.
- `install.sh`'s agent map is pinned to `src/agent-dirs.ts` and every preset's `skillsDir`.
- `docs/verify-an-agent.md` has a section per preset. `teach/sessions.json` maps each session to its release.

Not in v2.6.1:
- Live runs of any agent except Claude.
- The P40 re-check has still never fired live: the recorded run's verify stage raised no findings.
- The `resettable` opt-in, per-repo state databases and a base default from origin/HEAD (v2.6.2).

## v2.6.0

One factory, any agent. Every preset except Claude ships `verified: false`; participants verify them with
`factory verify-agent` (see `docs/verify-an-agent.md`). Every fixture except Claude's is synthetic, written
from each CLI's docs.

- New presets: `gemini`, `opencode`, `cursor`, `pi`, `mastracode`. Each declares its pinned `version`,
  the API keys it may see (`envKeys`), its skills dir, its context file and how it holds read-only stages
  (`readOnlyBy`). A stage's env now drops every other known provider key, so a Codex stage never sees the
  Anthropic key. Agents with a custom `command` keep the old behaviour.
- Gemini and Mastra Code parse through a per-run parser (`newParser`), because their events arrive as deltas.
- `factory install --agents a,b,c` links `.claude/skills` into each agent's skills dir and writes an
  `AGENTS.md` (or `GEMINI.md`) pointer only when absent. Ported from skills `internal/agents/agents.go`.
- The install always links `.agents/skills` too (the shared dir), and the Dockerfile now installs four CLIs by
  default (`claude codex gemini opencode`); pass `--build-arg AGENTS=claude` for the old image.
- `factory doctor` warns when an agent binary's version differs from its pin.
- The Dockerfile takes `--build-arg AGENTS="gemini pi"` and pins every agent's version; a build with two
  agents was run. Cursor is host-only (`docker: false`): it has no pinnable download.
- `docs/agents.md`: a matrix generated from the registry (a test fails if they drift), a safety table and an
  aider walkthrough. One registry test walks every preset for its fixture, pins, install target and docs.
- Agents page and `GET /api/agents`. New `factory-operator` skill (ported from machinist's skill).
  `tests/docs-links.test.ts` checks every `*.md` for unbalanced fences and dead local links (blueprint).
- `FixtureRecorder` replaces a synthetic fixture instead of appending to it.

Not in v2.6:
- Live runs of any agent except Claude. OpenCode and Cursor event shapes are from memory, not from a
  capture. Mastra `--mode plan` as read-only, Pi print mode reading stdin and OpenCode reading stdin are
  unconfirmed until a participant runs them.
- omp and Amp are cut; either still runs as a custom `command`. Mistral Vibe is config-only.
- `prompt.ts` keeps reading the canonical `.claude/skills`, because `install` always writes it and links the
  other agents' dirs to it. There is no `renderPolicy` hook; each preset's `command` applies `stagePolicy`.
- The Agents page shows configuration and pins, not the installed version or doctor rows.

## v2.5.2

Makes v2.5 work on a real run. Every fix has a test that fails when the fix is reverted.

Correction to v2.5.1: its note "the provenance test now checks one ported test per row" was wrong. The test
checks each ported file's header and notice, not the rows of `research/upstream.lock`, and that lock file
sits outside this repo, so no test here can read it. `THIRD_PARTY_NOTICES.md` plus the provenance test are
the in-repo record; the lock's `shipped:` line was corrected by hand.

- Verify no longer runs on a red gate: a failing fresh gate goes back to build, or to failed at the round cap.
- The gate tree now hashes the working tree, so uncommitted build edits no longer look like "same tree".
- Read-only stages may run `git rev-parse`; a test checks every command a skill tells an agent to run
  against its stage allow-list.
- Step artifacts are validated for required fields and enums from `src/schemas.ts`. `outcome: blocked`
  without a verdict routes to needs-human. Review rounds live in the runner, not the artifact.
- Rehydrate writes the build object shape. The per-run event budget is evicted when the run ends.
- `factory doctor` warns when installed skills differ from this runner, and when a preset is not verified.
- The dashboard cookie gets `Secure` over https. Durations under a minute show whole seconds (`42s`).
  Board titles and stage rows pass through `plain()`, with a test that walks every read route.
- Finding re-check (P40): after verify, Claude re-checks each must/should finding against the diff in a
  tool-free call and drops the unsupported ones. Fails open. Runs only when Claude is the verifier.
- Ported assembler runtime cases: literal prompt args, stdin/stderr/exit preserved, hung-process timeout.
- `bin/factory` is now type-checked (it has no `.ts` extension, so `tsc` skipped it). That found an
  out-of-scope `config` in `buildWatchDeps` and a type error in `park`.
- Participant verification path: presets carry `verified`; `factory verify-agent <name>` runs one issue on
  that agent, records a scrubbed fixture and prints pass/fail, cost and tokens; `make agent-matrix` runs it
  for every installed agent; `docs/verify-an-agent.md` is the runbook. Only Claude is verified by us.

Live proof (Claude, splitbill issue #61, cent split): triage, plan, build, verify and pr all passed with
no manual step except approving the plan. 5 stages, about 4.5 minutes, $1.68. Verify passed 5 of 5
acceptance criteria and the PR changed only `src/money/cents.ts` and its test. `--json-schema` with no tools
returns `structured_output`, which the P40 re-check reads. Recorded fixtures: `tests/fixtures/agents/claude/`
(triage and plan) with a replay test; a preset can only say `verified: true` with a real fixture.

Not in this release:

- Claude fixtures for build, verify and pr: that run was not recorded. The next live Claude run adds them.
- The P40 re-check has not fired in a live run (verify raised no findings); only its call was probed live.
- R10: `cost_usd` stays `NOT NULL DEFAULT 0` in old databases. Incomplete usage is flagged by `usage_complete`.
- Assembler `readCommandDecision` and `runSDK` (dead code for a CLI runner) and `test/delivery.test.ts`
  (task-to-pr workflow, v2.8).
- Machinist `runs-view.test.js` (needs React, jsdom and vite; our dashboard has no build step),
  `artifacts_test.go` and the control-plane auth tests (a leased SQLite store and CSRF-protected HTTP
  artifacts; we keep artifacts as files under `.factory/runs/`). Nothing to port to.
- Live runs of any agent except Claude; participants verify those.

## v2.5.1

Finishes v2.5: the pieces it promised and did not ship.

- Cost meter: `src/pricing.ts` holds a dated per-model price table. An unknown model is "not reported",
  never $0. `stage_runs` gains `tokens_cached` and `usage_complete` (guarded, idempotent `ALTER`), and the
  dashboard shows "Not reported" for incomplete usage.
- Stage policy: triage, plan and verify run Codex with `-s read-only` and return their artifact as the final
  message; the runner validates it (`src/agents/reply.ts`) and writes the file. Build and pr keep
  `workspace-write`. Opt in to `--output-schema` with `outputSchema: true` on an agent.
- Stage artifacts get a JSON Schema built from the validators (`src/schemas.ts`), included in the artifact
  contract. Every step artifact accepts `outcome: complete|blocked|failed` and rejects unknown fields;
  `blocked` goes to needs-human with the reason.
- Event log has a 32 MiB byte budget per run, with a `process.output_truncated` marker.
- A `command` agent that is really `codex exec` or `claude -p`, even behind `env`, `mise` or `direnv`, gets
  its JSON flag and preset parser.
- Verify refuses stale evidence: if `gate.json` names a different tree than HEAD, the gates re-run first.
  Triage refuses an issue another open PR already closes, before any tokens are spent.
- Skills: `outcome` is taught, verdict comments render `pass|fail|unverified` per criterion, AC ids are never
  renumbered, build stops after 3 failed gate runs.
- Dashboard: the session cookie is a random id, not the token. Thread, run titles, artifact previews and CLI
  errors pass through `plain()`. `InboxChannel` interface, inbox argument parsing and every ChatOps
  command are tested.
- Provenance: the test now checks one ported test per row and Markdown ports.

Not in this release:

- No live Codex run (#18). Claude gets no `--json-schema`; `outputSchema` is opt-in.
- `gpt-5.6-terra` is unpriced, so its cost is not reported. Incomplete usage stores `cost_usd = 0` with
  `usage_complete = 0`, not NULL.
- A read-only reply's artifact is capped at 16 KiB.
- The tool-free finding re-check call (P40) was still prompt text only here; v2.5.2 made it a second tool-free call.
- Sub-minute durations keep the upstream `42.5s` format.
- Upstream `runs-view.test.js`, `artifacts_test.go` and the auth tests are not ported.
- Real Claude fixtures per stage are not recorded; they spend tokens.

## v2.5.0

Any coding agent: the factory no longer knows Claude by name. An agent is config.

- `src/agents/`: one `CommandExecutor` (spawn, prompt on stdin or in the command, timeout, process-group
  kill, stderr tail, bounded event log, tool-call cap) and presets for `claude` and `codex`. Claude's
  command is unchanged from v2.4.0 (a test pins it), plus `--model` when `agent.model` is set.
- `.factory/config.json` gains `agents` (a `preset`, or your own `command` with `{{prompt}}`,
  `{{promptFile}}`, `{{model}}`) and `stages` (`default` plus per-stage overrides, so one agent can build and
  another verify). Config is validated at boot, including an unknown preset or stage.
- Any agent that can write files works with no adapter: it gets the stage skill plus an artifact contract, and
  `FACTORY_ARTIFACT_DIR`, `FACTORY_ISSUE`, `FACTORY_STAGE`, `FACTORY_SCRATCH_DIR`. Runner credentials and repo
  `GIT_*` variables are stripped from its environment. Without a preset, tokens show as not reported.
- Token totals follow machinist: the last terminal event wins, malformed usage is "not reported", never zero.
  `stage_runs` records which agent and model ran each stage.
- Verify: findings are structured (`must|should|could`, confidence 0-5, what/why/where/fix) and per-criterion
  `pass|fail|unverified`. The runner sends a self-contradicting `pass` to a human. A step result must be one
  JSON object under 16 KiB. The runner writes `gate.json` (gate line and git tree hash) so a read-only
  verifier trusts current evidence instead of re-running the gates.
- After a timeout the runner stops waiting on pipes held by a descendant that left the process group.
- `factory doctor` checks the binary of each agent a stage uses and warns about one with no preset.

Not in this release: Gemini, OpenCode, Pi, omp, Mastra Code and Amp presets (v2.6.0). The Codex preset is
covered by recorded-shape tests only; a live run is pending.

## v2.4.0

The cockpit: a redesigned dashboard and one place for everything that waits on a human.

- `src/inbox.ts` and `factory inbox [<N> <action> [--text <words>]] [--json]`: what is waiting (plan to
  approve, question, PR in review, parked, failed) derived from labels and the thread. Acting posts the same
  `/factory` comment a human would type, so GitHub stays the only state.
- Dashboard redesign, no build step: machinist design tokens (light, dark, system), self-hosted Manrope
  (OFL), a sidebar that becomes a bottom nav under 768px. Views: Inbox (conversation and composer), Line
  (one row per issue, stations sized by duration), Runs, Analytics, and a run side sheet with stages,
  artifact preview and log.
- New routes: `/api/inbox`, `/api/inbox/:n/act`, `/api/analytics`, `/api/runs/:id/stages`,
  `/api/issues/:n/artifacts`, `/api/line`. Artifacts are text only, capped at 1 MiB, sandboxed headers.
- Dashboard auth: constant-time token compare, header or HttpOnly session cookie (`POST /api/session`),
  no `?token=`, and a default-deny route allow-list proven by a test that walks every route.
- `factory logs N [--follow] [--json]`; terminal control sequences stripped from displayed text; revision
  history keeps every earlier `/factory revise`.
- Ports from owainlewis/machinist and assembler, with their tests, recorded in `THIRD_PARTY_NOTICES.md`
  and enforced by `tests/provenance.test.ts`.

Not in this release: the merge dry-run inbox item (v2.9), the Agents page (v2.6).

## v2.3.0

Honest foundation: what the README and labels promise now matches what the code does.

- `/factory cancel` closes the issue and any PR, removes the labels and the worktree, from every waiting
  state (needs-info, awaiting-approval, needs-human, failed, in-review). Before, it only worked at plan
  approval and never closed the issue, and in needs-info it was recorded as the answer.
- `.factory/config.json` is validated at boot: unknown or mistyped keys and wrong types refuse to start,
  and every problem is listed at once. `riskCriteria` and `_comment` keys stay allowed.
- New `stage_runs` table: one row per stage attempt (duration, tokens, cost, exit, kill reason), so retries
  keep their history. Forward-only migration; existing databases are upgraded in place.
- `--json` on `run`, `tick`, `watch --once` and `doctor`, with a documented exit-code table (2 run failed,
  3 paused, 4 doctor failed). Pattern from jiractrl.
- The Claude Code pin moves from 2.0.5 to 2.1.281 (Dockerfile and CI template); every flag the executor passes
  is present in that version's `--help`. A test keeps the two pins equal.
- Docs: the `factory:failed` label text, the dashboard bind comment and the README no longer claim a
  `factory:monitor` stage (that label marks issues filed by `factory scan`).
- Fix: `claim` and the runner's commits failed on a host with no git identity (a fresh CI runner or
  container). The runner now supplies a fallback identity only when none is configured. `make test` runs
  with no identity so this cannot hide on a developer machine again.

Not in this release: a monitor stage (v2.8), any agent besides Claude (v2.5).
