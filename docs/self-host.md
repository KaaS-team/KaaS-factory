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
| `KAAS_RELAY_PUBLISH_TOKEN`, `KAAS_RELAY_SUBSCRIBE_TOKEN` | Relay tokens, 16 characters or more and different. Unset, `up` makes a pair and writes the subscribe token to `$FACTORY_HOME/relay-subscribe-token`. |
| `FACTORY_BLOB_BUCKET`, `FACTORY_BLOB_ENDPOINT`, `FACTORY_BLOB_ACCESS_KEY_ID`, `FACTORY_BLOB_SECRET_ACCESS_KEY`, `FACTORY_BLOB_REGION` | An S3-compatible bucket (Cloudflare R2 works). |
| `FACTORY_BLOB_DIR` | A shared directory instead of a bucket. |

## The blob store

A runner on another machine uploads each stage's transcript and artifacts when the stage ends,
under `runs/<owner>/<name>/issue-N/`. The plane copies new keys onto its own run paths every 30
seconds, so its run page shows them. Set the same blob variables on the plane and on every runner.
Agents never see them: the executor strips every `FACTORY_` variable.

## Memory

`bun src/deploy/rss.ts <pid>` prints the resident memory of a process and its children, and fails
above 150 MB. CI runs it inside the built image after it starts idle.
