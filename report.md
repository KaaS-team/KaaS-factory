BRANCH: go/k9-workflow-md
HEAD: d4c1a06fb5832eaea37ba7877eb2609494566880
## Summary
Most of the markdown workflow format was already on `next` (LoadMarkdown, front matter, nodes, safe_outputs, triggers). I added the gap: `imports:` with topological expansion and full-path cycle errors, `Graph.Hash` (sorted-key canonical JSON sha256) for markdown and YAML workflows, did-you-mean on unknown keys and step types, and a load-time refusal of write credentials on agent nodes.
Found already there: LoadMarkdown/LoadDefault/ParseYAML/ParseMarkdown, splitFrontMatter, hand-written key validation, safe_outputs, template variable checks, existing workflows still load (TestEveryExistingWorkflowLoads passes).
Measures: non-test Go lines (outside src/) 21276 -> 21337 (+61). Deadcode 70 -> 70 (only the existing LoadDir, line number moved).
Not ported from gh-aw: I wrote the DFS, edit distance and hash myself (upstream schema_suggestions is JSON-schema driven, import_cycle is shaped for its own types), so no ported header or notice section was added. Upstream was cloned at 741ff0c but nothing was copied.
Gate: `just` is missing; ran by hand gofmt, go vet ./..., golangci-lint (graph package: 0 issues), go test ./... (all ok), go test -race on graph, conformance and cmd, CGO_ENABLED=0 build. Full-repo `-race` and the `-tags ee` pass were not run (memory limit in this sandbox).
## Acceptance
- JSON-schema validation with did-you-mean suggestions -> TestDidYouMean, TestEditDistance -> partial: did-you-mean done for unknown top-level keys, step keys and step types; no JSON-schema library added (none is named in the ticket, and the existing hand validation already covers the same keys).
- Imports expand in topological order -> TestImportsTopologicalOrder, TestImportRefusals -> done
- Cycles reported as a full path (a -> b -> c -> a) -> TestImportCyclePath -> done
- Sorted-key canonical JSON sha256 recorded in the eval scorecard and ledger -> TestCanonicalHash -> partial: Graph.Hash is computed and tested; writing it into the scorecard and ledger is in internal/eval and the ledger package, outside my area (see API change requests)
- Workflow whose agent node requests a write credential is rejected at load -> TestWriteCredentialRefused -> done (new `credentials:` key, top level and per step; a name ending `:write` or naming a token, secret or `_KEY` is refused on agent nodes, allowed on check nodes)
Bite-checks (each fix reverted once, test went red): cycle check removed (test hung until killed, red), topological order reversed, body dropped from the hash, suggestion disabled, `:write` rule removed, agent-node check disabled. The import path-escape check was removed as redundant (filepath.IsLocal already refuses `..` and absolute paths; covered by TestImportRefusals).
## API change requests
- internal/eval: add `WorkflowHash string` to Scorecard and set it from `graph.Graph.Hash`; the ledger entry for a run should carry the same hash.
## Files outside my area
none (internal/graph/frontmatter_test.go was edited: TestLoadMarkdownEqualsYAML now clears Hash before comparing, since nodes: and steps: spellings hash differently).
## Gate evidence
(`just` not installed; by hand) golangci-lint: `0 issues.`; go test ./internal/graph ./internal/conformance ./cmd/...: ok.
## Learnings
- `just` is not in the sandbox image; install it or ship the recipes as a script.
- Cloning upstream and `go run` of lint/deadcode take minutes and can hit the memory limit; cache the toolchain and tools in the image.
- A mutant that removes cycle detection recurses until OOM; a depth guard would make the bite-check fail fast.
