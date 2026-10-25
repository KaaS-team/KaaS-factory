# Lightning-2 live walkthrough: Build Your First Software Factory Execution Harness

This is the run sheet for a live demo on `splitbill-demo` with runner v2.12.3. It is organised around the four
outcomes the lesson promises: a worktree for every task, sandbox boundaries, one execution harness, and your
own branch kept isolated. Every repo command runs from `factory/` unless a step says otherwise. Issues are
named by title because `reset` reseeds them under new numbers; get the current numbers with:

```bash
gh issue list -R learnwithparam/splitbill-demo --state open
```

## 1. Pre-flight (T-30 min)

| Step | Where | Command | Expect |
|---|---|---|---|
| 0 | `factory/` | `git pull` on `main` | includes #21 (holdout tree-hash fix). Without it every verify parks `factory:needs-human` with a stale `gate.json` tree |
| 1 | any | `gh auth status` and `claude --version` | logged in to github.com; claude runs |
| 2 | `factory/` | `bin/factory reset --repo-dir ../splitbill-demo --dry-run` | only `close-issue`, `create-issue`, `wipe-*` lines; no `drop-commit` unless a PR was merged |
| 3 | `factory/` | `bin/factory reset --repo-dir ../splitbill-demo` | seven open issues, no `factory:*` label on any |
| 4 | `factory/` | `bin/factory doctor --repo-dir ../splitbill-demo` | no `[fail]` and no `[warn]` rows. A `[warn]` on the claude pin means your local `claude` is not 2.1.286 |
| 5 | `splitbill-demo/` | `git switch -c my-feature` and edit one line of `README.md`, unstaged | your own work in progress, used in scene 4 |
| 6 | any | the tmux layout in section 3 | five windows |

Close notifications and raise the terminal font. `reset` force-pushes `main`; it worked on 2026-10-01 with
the repo's current settings. If it ever fails on its first push, see "Deliver and reset" in splitbill-demo's
`DEMO.md`.

## 2. How the harness is event-driven

```
 you label an issue          watch polls GitHub every pollIntervalSeconds (15)
 factory:ready  ───────────► pollOnce: route each issue by its one state label
                                        │
                     claim: push branch factory/issue-N (compare-and-swap; a lost race skips the issue)
                     worktree: ~/.factory/learnwithparam/splitbill-demo/workspaces/issue-N
                                        │
 triaging ─► planning ─► awaiting-approval ─► building ─► verifying ─► in-review (PR ready)
                │              │ low risk: auto-approve      │ gates + holdout + verifier
                │              │ else: /factory approve      │ reject: rebuild, then needs-human
                ▼              ▼
   parked: factory:needs-info | factory:needs-human | factory:failed   (a human or /factory retry resumes it)
```

- **Labels are the state machine** (`src/labels.ts`). An issue carries one state label at a time, and every
  transition is a label swap you can watch on GitHub.
- **Comments drive transitions.** `/factory approve`, `/factory revise <text>`, `/factory retry` and
  `/factory cancel` from an owner, member or collaborator. A plain comment answers a question the agent asked.
- **Each stage is one agent process** in the issue's worktree, with a timeout and a tool-call cap. Its
  artifacts land in `.factory/runs/issue-N/` inside that worktree; its events go to
  `~/.factory/learnwithparam/splitbill-demo/factory.db`, which feeds `factory logs` and the dashboard.
- **Worktree lifecycle.** Created at claim, reused across every stage and every revise, removed by
  `/factory cancel` (the branch is kept) or by `reset`. It is not removed when the PR opens.
- **Concurrency.** Up to `concurrency` (3) issues run at once, each in its own worktree, capped by this
  machine's slots (`doctor` prints the number; 2 on the demo laptop).

## 3. tmux layout

`make demo` in `factory/` builds this layout and attaches (`make demo RECORD=1` records it), and
`teach/demo/lightning-2.sh snap <name> [window]` saves a deck screenshot. By hand, from `software-factory/`:

```bash
tmux new-session -d -s lightning-2 -n you -c splitbill-demo
tmux new-window -t lightning-2 -n factory -c factory 'make up REPO_DIR=../splitbill-demo'
tmux split-window -t lightning-2:factory -v -c splitbill-demo \
  'while :; do clear; git worktree list; ls ~/.factory/learnwithparam/splitbill-demo/workspaces 2>/dev/null; sleep 2; done'
tmux new-window -t lightning-2 -n logs -c factory
tmux new-window -t lightning-2 -n boundary -c splitbill-demo
tmux new-window -t lightning-2 -n flow -c splitbill-demo \
  'while :; do clear; gh issue list -R learnwithparam/splitbill-demo --state all --limit 10 --json number,title,labels -q ".[]|\"#\(.number) \(.title[0:40])  \(.labels|map(.name)|join(\" \"))\""; sleep 5; done'
tmux attach -t lightning-2
```

| Window | Shows |
|---|---|
| `you` | your checkout of splitbill-demo on `my-feature` |
| `factory` | top: watch + dashboard (`make up`), bottom: `git worktree list` every 2s |
| `logs` | `bin/factory logs <N> --repo learnwithparam/splitbill-demo --follow` for the issue on screen |
| `boundary` | the config and hooks that bound an agent (scene 2) |
| `flow` | every issue with its labels, every 5s |

Keys: `prefix w` lists windows, `prefix n` / `prefix p` move, `prefix z` zooms a pane, `prefix d` detaches
and leaves everything running. The dashboard is at http://localhost:4100.

`factory logs --follow` prints a stage's events when that stage ends, not token by token. While a stage runs,
the dashboard's live counters and the `flow` window are the moving parts to point at.

## 4. Scenes

### Scene 1: a worktree for every task (about 10 min)

1. On GitHub, add `factory:ready` to **"README has no run steps or CLI example"** and to **"Splitting $10.00
   three ways loses a cent"**.
2. Within 15s the `flow` window shows both move to `factory:triaging`. The bottom of `factory` shows two new
   worktrees, `workspaces/issue-<A>` and `issue-<B>`, each on its own `factory/issue-N` branch.
3. Show the claims: `git ls-remote origin 'refs/heads/factory/*'` in `you`.
4. Both plans are low risk, so they auto-approve and build in parallel. Open one worktree to show it is a
   full checkout: `ls ~/.factory/learnwithparam/splitbill-demo/workspaces/issue-<A>/.factory/runs/issue-<A>/`.
5. Add `factory:ready` to **"Upgrade hono 3.12.12 to 4.x"**. Its plan is high risk and stops at
   `factory:awaiting-approval`. Comment `/factory cancel`. The issue closes and its worktree disappears from
   the bottom pane; `git ls-remote` still lists its branch.

Say: one issue, one branch, one directory. Agents never share a working tree, so two builds cannot step on
each other, and cancelling one cleans up only its own directory.

### Scene 2: sandbox boundaries (about 10 min)

In `boundary`:

```bash
jq '{protectedPaths, agentCommands, maxBudgetUsd, concurrency, holdout}' .factory/config.json
jq '.permissions' .claude/settings.json
sed -n 1,40p .claude/hooks/guard-paths.sh
```

- `protectedPaths` (`src/auth/**`, `.factory/**`, `.claude/**`, `.agents/**`, `.github/**`) can never be
  edited by an agent. The guard hook blocks the write, and the runner re-checks the diff after build.
- `agentCommands` lists the only shell commands each stage may run.
- `maxBudgetUsd` caps spend per stage; the stage timeout and `maxToolCalls` kill a runaway agent's whole
  process group.
- `holdout.paths` are hidden from every agent's worktree by sparse checkout; only verify runs them.

Then add `factory:ready` to **"Any group member can delete any other member's expense"**. The fix needs
`src/auth/permissions.ts`, a protected path, so triage refuses it and nothing is planned or built. Show the
triage comment on the issue.

Paths you cannot force live (timeout, verify reject, boundary hit, denied tool, lost claim, crash recovery)
replay offline, one named test each:

```bash
bun test tests/scenarios.test.ts
```

### Scene 3: one execution harness (about 15 min)

Follow the README issue end to end. In `logs`:

```bash
bin/factory logs <A> --repo learnwithparam/splitbill-demo
bin/factory logs <A> --repo learnwithparam/splitbill-demo --stage build
```

Point at each hand-off: the label on GitHub, the stage artifact in `.factory/runs/issue-<A>/`
(`triage.json`, `plan.json` and `plan-comment.md`, `build.json`, `gate.json`, `verdict.json`), and the cost per stage:

```bash
sqlite3 ~/.factory/learnwithparam/splitbill-demo/factory.db \
  'select issue, stage, agent, tool_calls, round(cost_usd,3), duration_ms/1000 from stage_runs order by id'
```

When the label reaches `factory:in-review`, open the PR: it closes the issue, the gates ran, and the
verifier's verdict is posted. On the PR, comment `/factory revise add a curl example for GET /api/groups`
to show the same PR getting a new commit rather than a second PR.

Anything waiting for a human, in one list:

```bash
bin/factory inbox --repo learnwithparam/splitbill-demo
bin/factory inbox <N> approve --repo learnwithparam/splitbill-demo
```

### Scene 4: your branch stays isolated (about 5 min)

Switch to `you`:

```bash
git status --short
git branch --show-current
git worktree list
```

You are still on `my-feature` with your one-line edit. Every agent worked in its own worktree under
`~/.factory/`, on its own branch, so your checkout, index and stash were never touched. `git worktree list`
shows them side by side with yours.

### Scene 5: watch and take over (about 5 min, v2.12)

Start with `teach/demo/lightning-2.sh --tmux up`: the watcher opens a window per running issue in tmux
session `factory`.

1. Label **"CSV export shows raw cents instead of a formatted amount"** `factory:ready`.
2. `bin/factory attach <N> --repo-dir ../splitbill-demo` jumps to its live window.
3. Mid-build, `bin/factory takeover <N> --repo-dir ../splitbill-demo`. Accept Claude's folder-trust
   prompt, steer it in one message, then `/exit`. The handback posts `/factory retry` and build resumes
   with your edits.
4. The PR's "Factory run" table lists the takeover as its own build row.

## 5. Consuming a ticket

1. File it from the issue form (**New issue** on GitHub). The form sets the type label (`bug`, `feature`,
   `docs`, `security`, `dependency`).
2. Add `factory:ready` when you want the factory to take it. Nothing happens to an issue without that label.
3. If it parks at `factory:needs-info`, answer in a plain comment or in the dashboard. At
   `factory:awaiting-approval`, comment `/factory approve` or `/factory revise <what to change>`.
4. The PR is opened as a draft and marked ready once verify passes. The factory never merges.

## 6. If something goes wrong live

| Symptom | Do |
|---|---|
| Nothing moves after 30s | check the top pane of `factory` for an error; `bin/factory doctor --repo-dir ../splitbill-demo` |
| A stage runs long | it is killed at the stage timeout; meanwhile show the dashboard and move to the next scene |
| An issue parks `factory:failed` or `factory:needs-human` | read the parking comment; `bin/factory inbox <N> retry --repo learnwithparam/splitbill-demo` |
| A stage hits its budget | same as above: it parks, and the comment names the cap |
| GitHub is slow | switch to the recorded run: `teach/demo/lightning-2.sh replay` (section 8) |
| `Failed to start server. Is port 4100 in use?` | an older dashboard holds the port: `lsof -ti :4100` and stop it, or read the dashboard on the port it is already serving |
| Verify says `gate.json` tree differs from `HEAD^{tree}` | the runner predates #21: stop it, `git pull` in `factory/`, start it again, then `inbox <N> retry` |
| An issue stops moving after a restart | stop the watcher with Ctrl-C in its pane, never by killing the pane: a killed pane can leave the old watcher running and holding the slots |
| A `/factory` command is ignored | it must start the comment; post it on its own |
| A PR `/factory revise` rebuilds with no change | the runner and skills predate v2.12.1: `bin/factory install ../splitbill-demo --update` |

## 7. Close: deliver and reset

```bash
gh pr merge <n> -R learnwithparam/splitbill-demo --squash --admin
bin/factory reset --repo-dir ../splitbill-demo --dry-run   # lists the merge as drop-commit
bin/factory reset --repo-dir ../splitbill-demo
```

Then in `splitbill-demo/`: `git switch main && git branch -D my-feature`, and `tmux kill-session -t lightning-2`.

## 8. Walk through a finished run without running it

Before the reset in section 7 wipes the run, save it from `factory/`:

```bash
teach/demo/lightning-2.sh snapshot            # into ~/.factory/recordings/lightning-2/v<version>/snapshot
teach/demo/lightning-2.sh snapshot ~/runs/r3  # or a dir you name; an existing dir is refused
```

The snapshot is a small `FACTORY_HOME`: a consistent copy of `factory.db` (`sqlite3 .backup`) and each
issue's `.factory/runs/issue-N/` artifacts. Nothing is spent and no watcher runs. Any time later, even
after the reset:

```bash
teach/demo/lightning-2.sh replay              # http://127.0.0.1:4101; REPLAY_PORT picks another port
```

| Page | Shows |
|---|---|
| Line | every issue of the run, block by block, with the park reasons |
| Runs, Analytics | each stage's agent, duration, tool calls and cost, from the snapshot |
| An issue's artifacts | `plan.md`, `triage.json`, `gate.json`, `verdict.json` as they were written |
| Inbox, threads | live GitHub: the closed issues and PRs keep their comments, but the Act buttons post real comments |

`tests/demo-script.test.ts` takes a snapshot, wipes the source, replays it and reads the Line, Runs and artifact routes.
