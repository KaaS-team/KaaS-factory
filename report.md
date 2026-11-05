BRANCH: cluster/v7.0-api-writes
HEAD: 5ff371a7132bbf8aeff778b11666f95b3ecb87d7
## Summary
Added POST /api/runs/:repo/:issue/approve, /steer and /retry. They post the same /factory command as `factory inbox <n> <action>`, through the same `act`. They are token-gated, refuse a bad state with 409 and post nothing, and are listed in openapi.json.
## Issues
- #620: done. All tests are in tests/api-writes.test.ts.
  - Routes exist, need the token, act like the CLI -> "approve posts the same /factory approve command the CLI posts", "steer posts /factory revise with the text, and needs text", "retry posts /factory retry on a parked run", "approve, steer and retry exist as POST token routes", "the client calls the write routes and surfaces a refusal" -> mutations: api-retry-route-posts-approve.json, api-steer-accepts-empty-text.json.
  - No token is refused, walked over every write route -> "every write route refuses a request without the token and posts nothing" -> api-writes-skip-the-token-gate.json.
  - Wrong state gives a clear 409 and changes nothing -> "an action the run's state does not allow is a 409 and posts nothing" (also 404/400 cases) -> api-writes-post-without-checking-run-state.json.
  - openapi.json lists the routes -> "openapi.json lists each write route as a token-gated POST", and tests/api-routes.test.ts "openapi.json matches buildOpenApi output" -> n/a (the committed file is pinned to the builder).
  - Each mutation was run with `bun scripts/check-mutations.ts "<name>"` and reported as caught.
## Staged workflow changes
none
## Checkpoints
#620: 1 yes (files outside the area are listed below), 2 yes, 3 yes, 4 yes (the new tests failed with the change reverted, by mutation), 5 yes (no cap or baseline moved), 6 yes (api-*, route-scopes tests pass, 3x), 7 yes.
## Files outside my area
- scripts/openapi.ts: emits `requestBody` for a route with a `body` schema (steer).
- src/route-scopes.ts: the three new routes declared as `edit-structure`, because tests/route-scopes.test.ts requires every non-GET route to be. I updated the header comment to match.
## Gate evidence
make fast: ok
## Risk and rollback
Risk: live `factory serve` posts via `makeScm(DEFAULT_CONFIG)` (GitHub, the runner's account), and the comment carries no actor signature. Steer is `/factory revise <text>`, so it cannot answer a needs-info question. Roll back by reverting the single commit.
## Learnings
- The brief's goal list did not mention src/route-scopes.ts, which every new route must touch. Add it to the API cluster's file area.
- `make check-tests-only` flags `toBeDefined()` as a loose matcher. Assert the exact shape.
- The full `make test` took about 50s here, not over 2 minutes.
