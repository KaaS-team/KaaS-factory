# Tracker API v1

The contract the factory's `http` tracker adapter (`src/adapters/http-tracker.ts`) speaks. kaas Tasks
implements it; a Linear or Jira bridge implements the same routes. The contract suite in
`tests/tracker-contract.test.ts` runs against the fake and the adapter, so a route renamed on one side fails
the gate.

## Shape

- Base URL from config `tracker.url`; every route is under `/tracker/v1`.
- Auth: `Authorization: Bearer <token>`, read from the env var named in `tracker.tokenEnv`. A token belongs
  to one workspace (tenant); a project from another workspace answers 404.
- `{project}` is the factory's `repo` string (`owner/name`), URL-encoded. The tracker maps it to its own project.
- Issue numbers are per project and stable. Bodies are Markdown, kept byte for byte, because the factory
  stores state in hidden `<!-- factory:data ... -->` comments.
- Errors: non-2xx with `{ "error": "<message>" }`. 404 for a missing issue or comment.

## Types

```ts
Issue   = { number, title, body, labels: { name }[], state: "OPEN" | "CLOSED", stateReason: string | null,
            comments: Comment[] }            // comments only on GET one issue; [] on lists
Comment = { id: number, author: string, authorAssociation: "OWNER" | "MEMBER" | "NONE", body, createdAt }
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

Pull requests stay on the code host. When the tracker is not GitHub, the factory finds an issue's PR by its
head branch (`factory/<n>-<slug>`) and posts the PR URL as a comment.

## Events

A tracker that can push sends CloudEvents to the factory's `POST /events` (see `docs/events.md`):
`tasks.task.ready` when `factory:ready` is applied, `tasks.task.updated` on edits. Push only wakes the
poller; the tracker stays the source of truth.
