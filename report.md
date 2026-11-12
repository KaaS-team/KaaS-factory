BRANCH: go/k8-trigger-guard
HEAD: 101646ec242be65cbbddfe2d1afd204fced2b96c
## Summary
Ported claude-code-action's trigger, actor and actor-filter rules into `internal/tracker/github/trigger.go` and wired the actor rules into `Trust`. The polling tracker has no webhook actor, so the event rules reach production only through `Comment.Actor`, which nothing fills yet.
## Acceptance
- comment author must equal actor; deleted/edited-by-other ignored -> TestEventFires, TestTrustCommandIgnoresEditedByOther -> done (rule and Trust.Command wiring; REST polling has no editor, so Comment.Actor stays empty until a webhook intake sets it)
- label/assignee triggers must match config -> TestEventFires -> done as a tested function (Event.Fires); not reachable from cmd/factory except through the comment path, since the tracker lists by label rather than receiving events
- bot logins normalised with "[bot]" -> TestSameLogin, TestBotLogin, TestAllowedBot -> done
- human-actor and write-permission check with allow-list for bots -> TestCheckActor, TestTrustRefusesNonHumanWriter -> done (Config.AllowedBots, Users API type lookup, 404 means unresolvable App)
- all as table tests -> done
Bite checks (each fix reverted once, its test went red): Comment.Actor check, human-actor check, deleted rule, label match, unresolvable-App rule.
## API change requests
none
## Files outside my area
- THIRD_PARTY_NOTICES.md: required section for the ported file (provenance test).
## Measures
- Non-test Go lines: 21276 before, 21413 after (+137). Over the 8000 budget; nothing was deleted because nothing became redundant.
- deadcode lines: 70 before, 70 after (BotLogin was unreachable at first; now used by CheckActor).
## Gate evidence
`just` is not installed; ran the recipe bodies by hand (gofmt, go vet, golangci-lint v2.13.2 with go1.26.7, go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory).
golangci-lint: 0 issues.
go test -race ./...: all packages ok (last lines: ok .../pkg/agentrun, ok .../pkg/sandbox); build: BUILD_OK
## Learnings
- `just` missing in the cloud image; the brief's fallback worked.
- The tracker polls REST, so webhook-shaped rules (actor, edited-by) need an intake that does not exist yet; tickets should say where events come from.
- The hub test fake needed a `GET /users/{login}` handler once the human check called the Users API.
- Untracked-file line counts: measure with `git add` first.
