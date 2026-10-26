# Self-host the control plane

One image holds the control plane, the relay (`kaas-relay`) and the receipt checker (`kaas-verify`).
Its default command, `up` with no repo, starts the plane on port 4100 and the relay on port 4200.
Every SQLite file lives under `FACTORY_HOME` (`/data` in the image).

## Three ways to run it

- **Docker Compose.** `docker compose up -d` builds the image and keeps `/data` on the
  `factory-data` volume. Both ports bind to 127.0.0.1; put a TLS proxy in front.
- **A laptop.** `bunx kaas-factory up` (or `bun bin/factory up` in a checkout) runs the same stack.
  It finds the relay through `KAAS_RELAY_BIN`, `kaas-relay` on `PATH`, or `relay/target/release`.
  Without one, the plane runs alone.
- **Coolify.** Point a Docker Compose app at this repo's `docker-compose.yml`, set the domain to
  port 4100, and use `/health` with host `127.0.0.1` as the health check.

## Settings

| Variable | What it does |
| --- | --- |
| `FACTORY_DASHBOARD_TOKEN` | Bearer token for the plane. Without it or GitHub sign-in, only callers on the box get in. |
| `FACTORY_GITHUB_CLIENT_ID`, `FACTORY_GITHUB_CLIENT_SECRET` | GitHub sign-in for members. |
| `GH_TOKEN` | The token the plane uses to post commands to GitHub. |
| `FACTORY_GITHUB_APP_ID`, `FACTORY_GITHUB_APP_PRIVATE_KEY` | A GitHub App, set together: its id and its PEM private key (`\n` escapes work). See below. |
| `FACTORY_GITHUB_APP_OWNERS` | The accounts whose installations the App serves, comma separated. It defaults to `FACTORY_REPO`'s owner. Anyone may install a public App, so an installation on any other account is ignored. |
| `KAAS_RELAY_PUBLISH_TOKEN`, `KAAS_RELAY_SUBSCRIBE_TOKEN` | Relay tokens, 16 characters or more and different. Unset, `up` makes a pair and writes the subscribe token to `$FACTORY_HOME/relay-subscribe-token`. |
| `FACTORY_BLOB_BUCKET`, `FACTORY_BLOB_ENDPOINT`, `FACTORY_BLOB_ACCESS_KEY_ID`, `FACTORY_BLOB_SECRET_ACCESS_KEY`, `FACTORY_BLOB_REGION` | An S3-compatible bucket (Cloudflare R2 works). |
| `FACTORY_BLOB_DIR` | A shared directory instead of a bucket. |
| `FACTORY_REPOS` | Comma-separated `owner/name` list the plane serves and mirrors. Defaults to every repo under `FACTORY_HOME`, plus `FACTORY_REPO`. |

## A GitHub App

With an App set, each `gh` call that names a repo runs with that owner's installation token, so each
owner spends its own rate limit. A token is minted per owner and minted again 5 minutes before it
expires. A repo the App is not installed on keeps `GH_TOKEN`. The plane also serves every repo the
App is installed on, read again every 5 minutes, and a signed-in member sees a repo only when GitHub
gives them at least read on it, asked again every 10 minutes. Their plane role still decides what
they may do. The break-glass token and callers on the box see every repo.

The issue and PR lists are read every 10 seconds, or every 120 seconds for a repo whose webhooks
arrived in the last hour; a webhook reads that repo again at once. Under 10% of the rate limit left,
checked at most once a minute per owner, the wait doubles.

## The blob store

A runner on another machine uploads each stage's transcript and artifacts when the stage ends,
under `runs/<owner>/<name>/issue-N/`. Every 30 seconds the plane copies new keys onto its own run
paths, for the repos it serves only, so its run page shows them. It skips and logs any other key.
The runner also uploads `state.json`, the issue's run row and stage attempts, after each stage and
when a run's status changes; the plane writes it into that repo's own `factory.db`, so Line, Runs and
Analytics show remote runs. A file whose rows name another repo or issue, or break the schema, is
refused whole. Each time a runner starts it uploads its clone's `.factory/config.json`, `mcp.json`,
workflows and minions under `runs/<owner>/<name>/config/`, and the plane copies them to
`FACTORY_HOME/<owner>/<name>/config/`. Settings, Workflows, Minions and Agents with `?repo=B` then
read B's own config: the plane's clone of B if it has one, else that copy. A copy is read only, so the
workflow editor and event replay answer 409 for it. Set the same blob variables on the plane and on every runner.
Agents never see them: the executor strips every `FACTORY_` variable.

## Memory

`bun src/deploy/rss.ts <pid>` prints the resident memory of a process and its children, and fails
above 150 MB. CI runs it inside the built image after it starts idle.
