# The control plane

The dashboard is the control plane: one Bun process and SQLite, with nothing else to run. People sign
in with GitHub, and an owner gives each person a role. `dashboard/plane/` holds the code.

## Roles

Each role can do everything the role below it can.

| Role | Can |
|---|---|
| viewer | read every page: runs, inbox, board, proof, analytics, settings |
| approver | merge a verified pull request |
| operator | mark issues ready, act on the inbox, reply, send `/factory` commands |
| owner | change the toggles, add and remove members, read the audit log |

Every route names the least role it needs. A route with no role needs owner, and
`tests/plane-access.test.ts` walks every route against every role.

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
the sign-in page, it acts as an owner. Changing or removing the token ends every session it opened. Use it to add the first owner and when GitHub is down. Read it
from a file, never type it on a command line:

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
