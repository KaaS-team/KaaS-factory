TICKET: m3-wire-a
NEXT: dcfb910410338caf9ab57a183db4d9a9b155aad7
## Wired
- internal/docgen, config.Describe -> hidden `factory docs cli|config`; TestDocsCommandPrintsTheCommittedReferences
- internal/dispatch/local Auth, LoopbackAddr -> `factory serve` (KAAS_SERVE_PASSWORD guards every route but /healthz and /readyz; a non-loopback --addr is refused without it) and `factory serve token`; TestServeGuardsRoutesWithThePassword, TestServeRefusesNonLoopbackWithoutPassword, TestServeTokenNeedsPassword. Adds serve.Options.Wrap (one small hook in internal/serve).
- internal/design -> `factory design tweak|stamp|edit`; TestDesignTweakRunsThePack, TestDesignTweakFailsWhenTheEditNeedsAnAgent, TestDesignStampAndEdit (fake node on PATH), TestDesignTweakOnTheRealPack (skips without npm ci in packs/design)
- internal/eval/assert -> eval fixtures take an `assert` list that gates each epoch (score 0, decided_by "assert"); TestFixtureAssertionsGateTheScore, TestFixtureAssertionsRejectUnknownType
- internal/firstrun WithExec -> `factory first-run --fix` (configured dispatcher, draft PR via GitHub, observer); WithExec now takes a lazy builder. TestFirstRunReportsWithoutDispatching, TestFirstRunFixDispatchesOneBuildAndOpensADraftPR, TestFirstRunFixNeedsAKnownDispatcher
## Deleted
- untrusted.Permitted and its allowlist test -> nothing called it; the run enforces the same allowlist through Restrict/allowedRule. The deny-list assertions were kept as TestDenyListKeepsTheEscapes.
## Left unwired
- internal/dispatch/broker (+brokertest) -> its NOTE.md says it needs a transport and a CEL gate; there is no CEL in the tree. A design decision, not a wiring.
- internal/eval/judgecache -> needs a model-calling Judge; no provider key is allowed.
- internal/eval/replay -> needs a live Sender; same reason.
- eval WithRunner, WithControl, WithNow -> test seams (WithControl needs a bare model, same reason as above).
- internal/api/porttest -> test fakes, dead in the binary by design.
## Bite checks
- TestDocsCommandPrintsTheCommittedReferences -> `unknown command "docs" for "factory"` with the docs AddCommand removed
- TestServeGuardsRoutesWithThePassword -> `no credential: 404, want 401` with `Wrap: nil`
- TestDesign* -> `unknown command "design" for "factory"` with designCmd removed
- TestFixtureAssertionsGateTheScore -> `a missing DONE still merged` and `a cost over the threshold still merged` with the assertGate result discarded
- TestFirstRunFix* -> `unknown flag: --fix` with WithExec removed
## Ratchet
deadcode 404 -> 307 (after rebases onto other sessions' pushes; base was 385/355 at the rebases). go_lines raised by hand with a new reason (40997 -> 42129 after merging others' growth).
## Gate evidence
./gate.sh (same steps as `just check`; just is not installed) on the pushed tree:
go_lines 42129 (baseline 42129), deadcode 307 (baseline 307)
exit 0
## Learnings
- Go 1.24 on the box: set GOTOOLCHAIN=go1.26.7, or deadcode reports every package as too new.
- FACTORY_* env vars are all parsed as config keys, so a new env var must use another prefix (KAAS_).
- `go build ./cmd/factory` drops a `factory` binary at the repo root; I committed it once and amended it out. Use -o /dev/null.
- .ratchet.json conflicted on both rebases; other sessions push every few minutes.
- Commit trailer: the brief named a model; I used `Co-Authored-By: Claude <noreply@anthropic.com>` since model names must stay out of commits.
