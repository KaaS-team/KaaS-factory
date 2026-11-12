BRANCH: go/linear-jira
HEAD: 5524607498aeedf0d41b7db1b52b0593b6ed8702
## Summary
`internal/tracker/linear` (GraphQL) and `internal/tracker/jira` (REST v3) implement `api.Tracker` with `Ready`, `Get`, `Comment` and `SetPhase`, over an injected retrying client in a small shared `internal/tracker/vendorkit`. Tests run against ported `httptest` fakes and request-body goldens recorded from the TS Linear adapter.
## Acceptance
- Linear: Ready, Get, Comment, SetPhase against the ported fake, matching TS request bodies -> linear TestReady, TestGetMapsTicket, TestRequestBodiesMatchTS (goldens recorded by running the TS adapter), TestCommentCarriesMarkers, TestSetPhase, TestSetPhaseSendsStateID -> done
- Jira: the same four against the ported Jira fake -> jira TestReady, TestReadySendsJQLAndAuth, TestGetMapsTicket, TestCommentSendsADF, TestCommentCarriesMarkers, TestSetPhase, TestSetPhaseSendsTransitionID -> done (v3 as the ticket says, so paths and ADF bodies differ from the v2 TS adapter; no byte goldens for Jira)
- 429 then 200 retries once, 403 does not retry -> vendorkit TestDoRetryRules, linear TestRetries, jira TestRetries -> done
- Phase with no mapping returns an error naming the phase -> linear/jira TestSetPhase "unmapped phase names the phase" (also asserts no request is sent) -> done
## API change requests
none
## Files outside my area
- `internal/tracker/vendorkit/` (new package, 4 files): the retry client and the marker codec (port of `kit.ts`) are needed by both adapters. Kept as one package instead of two copies. Rename or move it if another session claims the name.
## Gate evidence
`just` is not installed, so the recipe bodies were run by hand, all clean:
gofmt -l: empty; go vet ./...: clean; golangci-lint v2.13.2 (go run): `0 issues.`; go test -race ./...: all packages ok (cmd/factory, api/porttest, provenance, tracker/jira, tracker/linear, tracker/vendorkit); CGO_ENABLED=0 go build ./cmd/factory: ok.
## Learnings
- `just` is missing in cloud sessions; the default image should ship it, or the brief should list the manual commands once.
- The brief says REST v3 but the TS reference is v2, and v3 needs ADF bodies; the brief should say which wire format goldens follow.
- Local golangci-lint was v2.5.0, older than the pinned one; only `go run ...@v2.13.2` matched CI. The first lint pass with the old binary missed nothing here, but the version gap should be called out.
- Decisions to confirm: SetPhase also refuses to move an issue sitting in a state the factory does not own (reading "never touches states it does not own" that way); Linear `Priority` and Jira priority are not read (the Linear query is pinned to the TS text, so `Ticket.Priority` stays 0); `Get` returns descriptions raw without the TS seal decode, since the Tracker port has no issue-create path that writes markers into descriptions.
