# Live smoke test

Every other factory test uses fakes. The smoke test drives the real loop against one real GitHub
repository, with a fake agent script instead of a model. It is opt-in and skipped by default.

## Run it

```
FACTORY_SMOKE_REPO=owner/name GITHUB_TOKEN=... go test ./internal/smoke -run Live -v
```

`owner/name` must be a sandbox repository you do not mind writing to. The token needs to read and
write issues, pull requests and contents on it. Without both variables the tests skip and say which
one is missing.

## What it does

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
runs in the gate. The live variant has not been run from a cloud session, which has no sandbox
repository.
