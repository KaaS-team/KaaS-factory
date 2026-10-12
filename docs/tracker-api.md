# Tracker API v1

The contract the factory's `http` tracker adapter (`src/adapters/http-tracker.ts`) speaks. kaas Tasks
implements it; a Linear or Jira bridge implements the same routes. The contract suite in
`tests/tracker-contract.test.ts` runs against the fake and the adapter, so a route renamed on one side fails
the gate.

## Shape

- Base URL from config `tracker.url`; every route is under `/tracker/v1`.
- Auth: `Authorization: Bearer <token>`, read from the env var named in `tracker.tokenEnv`. A token belongs
  to one workspace (tenant); a project from another workspace answers 404.
- `{project}` is config `tracker.project` if set, else the factory's `repo` string (`owner/name`), URL-encoded.
- Issue numbers are per project and stable. Bodies are Markdown, kept byte for byte, because the factory
  stores state in hidden `<!-- factory:data ... -->` comments.
- Errors: non-2xx with `{ "error": "<message>" }`. 404 for a missing issue or comment, and for a login
  that is not a member (the factory reads that as role `none`).
- Applying a label the project does not have creates it.

## Types

```ts
Issue   = { number, title, body, labels: { name }[], state: "OPEN" | "CLOSED", stateReason: string | null,
            comments: Comment[] }            // on lists too: the runner reads them from the poll
Comment = { id: number, author: string, authorAssociation: "OWNER" | "MEMBER" | "NONE", body, createdAt }
// authorAssociation OWNER or MEMBER marks a trusted commenter, as on GitHub.
Role    = "admin" | "maintain" | "write" | "triage" | "read" | "none"
```

## Routes

| Method and path | Body | Returns |
|---|---|---|
| `GET /me` | | `{ login }` |
| `GET /projects/{project}/issues?state=open&label=<name>` | | `Issue[]` (label optional) |
| `GET /projects/{project}/issues/{n}` | | `Issue` |
| `POST /projects/{project}/issues` | `{ title, body, labels }` | `{ number }` |
| `PATCH /projects/{project}/issues/{n}` | `{ state: "open" \| "closed" }` | `{}` |
| `POST /projects/{project}/issues/{n}/comments` | `{ body }` | `{ id }` |
| `PATCH /projects/{project}/comments/{id}` | `{ body }` | `{}` |
| `POST /projects/{project}/issues/{n}/labels` | `{ add: string[], remove: string[] }` | `{}` |
| `GET /projects/{project}/issues/{n}/label-events?label=<name>` | | `{ actor: string \| null }` (last applier) |
| `GET /projects/{project}/labels` | | `string[]` |
| `PUT /projects/{project}/labels/{name}` | `{ color, description }` | `{}` (idempotent) |
| `GET /projects/{project}/members/{login}` | | `{ role: Role }` |

`tests/tracker-contract.test.ts` holds this table, `TRACKER_ROUTES` in the adapter and the reference server
(`tests/fixtures/tracker-server.ts`) to the same set.

## Pull requests

Pull requests stay on the code host (GitHub). When the tracker is not GitHub:

- an issue's PR is the one on head branch `factory/issue-<n>`;
- closing keywords in the PR title and body are rewritten (`Closes #4` becomes `Closes tracker issue 4`), so
  they cannot close an unrelated GitHub issue;
- the PR URL is posted on the tracker issue as `Pull request: <url>` with a `<!-- factory:pr-link v1 -->` marker;
- when the PR merges, the factory closes the tracker issue: at once when the factory merges it, and on the
  next poll when a human merges it on GitHub, whatever `merge.policy` says. A PR closed without merging leaves it open.

## Label names

The factory's label names (`factory:ready` and the rest) are what the API carries unless config `labels` maps
them, for example `{ "factory:ready": "ready-for-ai" }`. The map is applied at the tracker boundary only:
the factory sends the team's name and reads it back as its own.

## Events

A tracker that can push sends CloudEvents to the factory's `POST /events` (see `docs/events.md`):
`tasks.task.ready` when `factory:ready` is applied, `tasks.task.updated` on edits. Push only wakes the
poller; the tracker stays the source of truth.
