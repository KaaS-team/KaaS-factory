# The control plane

The dashboard is the control plane: one Bun process and SQLite, with nothing else to run. People sign
in with GitHub, and an owner gives each person a role. `dashboard/plane/` holds the code.

## Roles

Each role can do everything the role below it can.

| Role | Can |
|---|---|
| viewer | read every page: runs, inbox, board, proof, analytics, settings |
| approver | merge a verified pull request, approve a plan |
| operator | start a task, mark issues ready, act on the inbox, send every command below |
| owner | change the toggles, add and remove members, read the audit log |

Every route names the least role it needs. A route with no role needs owner, and
`tests/plane-access.test.ts` walks every route against every role.

## Commands

Each command is a comment on the issue, posted before the route answers. A runner that only polls
the tracker obeys it, and the tracker stays the one record of who asked for what.

| Route | Role | Posts |
|---|---|---|
| `POST /api/tasks` | operator | a new issue labelled ready, from `{"title", "body", "type"}` |
| `POST /api/issues/<n>/approve-plan` | approver | `/factory approve` |
| `POST /api/issues/<n>/revise` | operator | `/factory revise <text>` |
| `POST /api/issues/<n>/answer` | operator | the answer text |
| `POST /api/issues/<n>/retry` | operator | `/factory retry` |
| `POST /api/issues/<n>/cancel` | operator | `/factory cancel` |

The route reads the issue fresh and answers 409 when the issue is not waiting for that command, so
nothing is posted. The comment goes out under the runner's tracker account and ends with a line
naming who sent it. The runner strips that line before it reads the command or hands an answer to
the agent.

## Runners, steering a run in flight

A runner on another machine registers once with a one-time token from `POST /api/runners/token`
(owner), read from stdin by `factory runner register --url <plane>`. `factory runner start` then
dials out to `/runner/stream` and needs no open port. It beats every 15s. A lease whose runner is
silent for 60s goes back to the queue. `POST /api/issues/<n>/dispatch` (operator) queues an issue.

A job is an issue in one repo, and every route below takes `repo` in its body or query. Pass
`--repo-dir` once per checkout: `factory runner start --repo-dir ~/src/a --repo-dir ~/src/b`. The runner
tells the plane those repos, and it is leased work in them only. A job in a repo no runner holds waits.

| Route | Role | Does |
|---|---|---|
| `POST /api/issues/<n>/message` | operator | queues a message for the runner, kept in the run's folder |
| `POST /api/issues/<n>/messages/<id>/undo` | operator | withdraws it, until the runner has read it (then 409) |
| `POST /api/issues/<n>/takeover` | operator | posts a signed note, then stops the stage so a human can resume it |
| `POST /api/issues/<n>/stop` | operator | posts a signed note, then cancels the running stage |

## Phones

`factory pair --url <plane> --login <member>` prints a QR. The phone shows which member it would
pair as and claims only after a yes; a browser signed in as someone else is refused. It pins the key
the plane publishes, keeps its own key in the browser, and acts as that member until it is revoked
at `POST /api/devices/revoke` or the member is removed. The relay carries only boxes sealed for
paired phones of current members, and sends nothing while none is paired. Web Push sends only
"needs you" and "done", each subscription belongs to one member, and a member who has the dashboard
open gets no push.

## MCP

`factory mcp --repo <owner/name>` serves MCP on stdio with `list_tasks`, `read_task`, `start_task`
and `approve_plan`. They post the same signed comments as the routes above.

## Events, minions and workflows

The Events and Minions pages need operator, since event data and minion runs carry spend and agent
names. Events lists the outbox and inbox with each delivery's status, and Replay
(`POST /api/events/<id>/replay`) sends one event to its sinks again, like `factory events replay`.
Minions lists each minion, what starts it, whether it runs in a clone of the repo, and its last run.

The Workflows page is read-only. Its "Propose a change" form sets a step's agent, timeout or retries
and posts to `POST /api/workflow-edit` (operator). The runner rewrites the file, checks it with the
watcher's own parser, and opens a PR on a `factory/workflow-<name>-<hash>` branch. A form the
parser refuses answers 422, and nothing is pushed. The rewrite drops comments in the file.

## Turning on GitHub sign-in

1. Create a GitHub OAuth app. Set its callback URL to `https://<your plane>/auth/github/callback`.
2. Set `FACTORY_GITHUB_CLIENT_ID` and `FACTORY_GITHUB_CLIENT_SECRET` in the plane's environment.
3. Add the first owner with the break-glass token (below), then sign in at `/auth/github`.

The plane asks GitHub for `read:user` only. It reads the login once and keeps no GitHub token.

## Members

An owner adds, changes or removes a member with `POST /api/members` and
`{"login": "<github login>", "role": "operator"}`. A `role` of `null` removes the member. The role
is read on every request, so a change applies at once. Removing a member also ends their sessions.
A member's first sign-in pins their GitHub account id. If the login is later renamed and registered
by another account, that account is refused.

Members, sessions and the audit log live in `plane.db` under `FACTORY_HOME`. Set `FACTORY_PLANE_DB`
to keep them somewhere else. The database stores a digest of each session id, never the id itself.

## The break-glass token

`FACTORY_DASHBOARD_TOKEN` still works. Sent as `Authorization: Bearer`, or traded for a cookie on
the sign-in page, it acts as an owner. Changing or removing the token ends every session it opened. Use it to add
the first owner and when GitHub is down. Read it from a file, never type it on a command line:

```sh
curl -H @"$HOME/.config/factory/bearer-header" -H 'content-type: application/json' \
  -d '{"login":"octocat","role":"owner"}' https://<your plane>/api/members
```

## When the plane may face a network

A plane refuses any caller that is not on loopback until it is guarded by a token, GitHub sign-in,
or both. With neither set, it serves loopback only and treats that caller as the local owner.

## The audit log

Every `POST` from a signed-in caller writes a row: who, their role, the route, the issue and the
status the request ended with. A refused write is kept too, and so is each GitHub sign-in. Owners
read it newest first at `GET /api/audit`, a page at a time with `?before=<id>`. The log keeps the
newest 50,000 accepted writes and, separately, the newest 5,000 refusals, so a caller sending refused
writes cannot push real ones out.
