BRANCH: go/k8-host-guard
HEAD: 88a9fe7c7fee6283590b60f77e643dafba8e0c7a
## Summary
New `internal/serve/hostguard` (ported from coder/agentapi@7c468d5 `lib/httpapi/server.go`, huma and chi dropped) answers 403 to an unlisted Host or Origin. It is wired on the serve, dashboard and a2a listeners, loopback by default.
## Acceptance
- Request with unlisted Host or Origin gets 403 -> TestLoopbackDefault, TestServe_RejectsForeignHostAndOrigin, TestCommandRejectsRebindingHost (dashboard and a2a) -> done
- Loopback default -> TestLoopbackDefault, TestFromAddrAndEnv (named bind host, wildcard bind, env lists, malformed env) -> done
- Test for DNS-rebinding header -> TestLoopbackDefault ("dns rebinding host", "127.0.0.1.evil.com") plus the three listener tests -> done
- Bite-check: wiring reverted in each of serve, dashboard and a2a; the a2a test went red, and serve and dashboard went red as build failures only (the revert left unused imports). The Host check, the Origin check and the Origin allow rule were each broken once and their tests went red. Not run: the middleware without the Host or Origin parse funcs.
## API change requests
none
## Files outside my area
- internal/serve/serve.go, internal/dashboard/dashboard.go, internal/a2a/command.go: one-line wiring each, plus a test in each package. These are the listeners the brief names.
- THIRD_PARTY_NOTICES.md: the coder/agentapi@7c468d5 section.
- Not wired: `cmd/factory/ee.go` scim listener (cmd is outside my area; it is behind the ee tag). It needs `hostguard.New(addr, os.Getenv)(handler)`. No mcp http listener exists.
## Measures
- Non-test Go lines: 21276 before, 21427 after (+151, of which about 95 are the port; the rest is wiring).
- Deadcode: 70 before, 70 after.
- Left out of this ticket: ringbuffer, diff, claude.go and termexec (tickets 1 and 2 belong to other sessions).
## Gate evidence
`just` is not installed, so the recipe bodies were run by hand: gofmt clean, go vet clean, golangci-lint v2.13.2 "0 issues.", go test -race ./... and the ee-tag run with no failures listed, CGO_ENABLED=0 build "BUILD_OK". The last-lines tail was cut by my own filter, so the pass is inferred from there being no FAIL lines.
## Learnings
- The sandbox has no `just`; the factory could bake it into the image.
- A long chained gate exceeds the 120s foreground timeout; run it in the background from the start.
- Mutating the file inside a shell loop mangled my command once; use a script file.
