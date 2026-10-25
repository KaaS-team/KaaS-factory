# Trackers

Issues can live in GitHub (the default), behind Tracker API v1 (`http`, see `docs/tracker-api.md`), or in
one of five trackers the runner speaks natively. PRs always go to GitHub. Set `tracker` in
`.factory/config.json`; `tokenEnv` names the env var that holds the token, so the token is never in config.

| kind | keys | token | issue number |
|---|---|---|---|
| `linear` | `team` (key, e.g. `ENG`), `url?` | personal API key | the number in `ENG-42` |
| `plane` | `workspace` (slug), `project` (id), `url?` for self-hosted | API key (`x-api-key`) | the sequence id |
| `jira` | `url`, `project` (key), `issueType?` (default `Task`) | `email:api-token` (Cloud, Basic) or a PAT (Data Center, Bearer) | the number in `SHOP-42` |
| `clickup` | `workspace` (team id), `list`, `labelTrust?`, `url?` | personal token | the task id read as base 36 |
| `asana` | `workspace`, `project` (gids), `url?` | personal access token | the task gid |

```json
{ "tracker": { "kind": "linear", "team": "ENG", "tokenEnv": "LINEAR_API_KEY" } }
```

`url` must be https (plain http only to localhost). `factory doctor` checks the token and the
team, project or List, and names what is missing without printing the token.

## What the factory trusts

A label or a `/factory` comment drives the factory only when its author has a trusted role (admin, or
a member who can write). Each adapter maps its tracker's roles onto that and reads them on every call,
so a demotion counts at once. Guests are never trusted, and Linear and Asana treat a deactivated user
as no one.

- **Who added a label** comes from the tracker's history: Linear's issue history, Plane's activity log,
  Jira's changelog and Asana's stories. A label set when the issue was made has no history entry, so it
  names the issue's creator. A label renamed after it was added names no one.
- **ClickUp** has no public activity history, so label triggers are off unless `labelTrust: "creator"`,
  which credits any tag to the task's creator. `factory doctor` says which applies.
- **Scope.** Every read and write is limited to the configured team, project or List. ClickUp and Asana
  ids are global to the workspace, so the adapter checks each task's List or project first.

## Not covered

Every adapter is tested against a fixture server built from the vendor's public API docs
(`tests/fixtures/trackers/`), not against a live workspace. The native adapters take no webhooks; the runner polls them.
Why the adapters look the way they do: `docs/decisions/native-trackers.md`.
