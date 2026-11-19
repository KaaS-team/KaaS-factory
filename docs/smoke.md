# Live smoke test

Every other factory test uses fakes. The smoke test runs the first four commands a new user types
against one real GitHub repository. It is opt-in and skipped by default.

## Run it

```
FACTORY_SMOKE_REPO=owner/name GITHUB_TOKEN=... go test ./internal/smoke -run Live -v
```

`owner/name` must be a sandbox repository you do not mind writing to. The token needs to read and
write issues, pull requests and contents on it. Without both variables the tests skip and say which
one is missing.

## The four commands

`TestLiveCommands` builds the factory from your checkout, runs these in a scratch git directory and
checks that each exits 0 and prints something. The environment is `FACTORY_REPO` set to your
sandbox, tracker `github`, dispatcher `local`, and your token as `GH_TOKEN`.

```
factory doctor
factory first-run --dry-run
factory status --json
factory report
```

Healthy `factory doctor` is one `pass` row per check and no `fail`:

```
pass	git	/usr/bin/git
pass	gh	/usr/local/bin/gh (logged in)
pass	claude	/opt/node22/bin/claude
pass	go	/usr/local/go/bin/go
pass	config	loads
pass	dispatcher	/opt/node22/bin/claude
pass	env	no ANTHROPIC_* variable set
```

Healthy `factory status --json` is one JSON object, even when nothing is running. Plain
`factory status` prints one row per running ticket, so it is empty on a quiet board:

```
{"slots":[],"ready":[],"merge_queue":[],"fires_left":-1}
```

Healthy `factory report` is the unit-economics table. A fresh sandbox has zeros:

```
# Factory unit economics

| team | Merged PRs | Tokens per merged PR | Rework per PR | ...
| all | 0 | 0 | 0 | ...
```

`factory first-run --dry-run` needs the `auditor` binary on PATH
(`cargo install --git https://github.com/KaaS-team/auditor`). Without it the factory exits 2 and
the test skips that step with the same hint. With it, the output is the findings and what the
factory would fix, and nothing is changed.

`status` shows only the state this process has loaded, so it does not list the open issues of the
sandbox. Use the tracker to see them.

## The full loop (separate opt-in)

`TestLive` and `TestLiveShadow` drive the whole loop. They claim every `factory:ready` issue in the
repository, so run them only on a sandbox with none, and set `FACTORY_SMOKE_LOOP=1`:

```
FACTORY_SMOKE_LOOP=1 FACTORY_SMOKE_REPO=owner/name GITHUB_TOKEN=... go test ./internal/smoke -run 'Live$|LiveShadow' -v
```

## What the full loop does

`TestLive`:

1. Creates an issue titled `smoke <timestamp>` with the label `factory:ready` and a planned body
   that asks for one file, `smoke/<timestamp>.txt`.
2. Runs the core (GitHub tracker, local dispatcher, merge queue) in a temp directory. The local
   dispatcher starts the fake agent script, which writes the file, commits on `factory/<n>-a1`,
   pushes it, pushes a report commit to `report/<n>` and opens the pull request.
3. Waits for the core to queue the pull request and the merge queue to land it.
4. Asserts the pull request is merged and the file is on the base branch.

`TestLiveShadow` is the same run with `Shadow: true`. It asserts no pull request, no merge, no file
on the base branch and no comment on the issue.

## What it creates and cleans up

Created: one issue, the branches `factory/<n>-a1` and `report/<n>`, one pull request, and, in the
merged run, one merge commit that adds `smoke/<timestamp>.txt` to the base branch.

Cleanup closes the issue (and the pull request when it is still open) and deletes both branches.
It does not revert the merge: the file stays on the base branch, one small file per run.

Git credentials reach git through the environment (`GIT_CONFIG_*`), not a command line or a remote
URL. No model or provider key is used.

## Without a sandbox repo

`go test ./internal/smoke` runs the same orchestration and the same agent script against an
`httptest` GitHub and a local bare git remote, through the merge queue. That is the check that
runs in the gate. The four-command test ran from a cloud session against `KaaS-team/demo-sandbox`. The full-loop test
did not pass there: the session proxy refuses branch deletes and the loop ended in needs-human.
