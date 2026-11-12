BRANCH: go/k3f-graph
HEAD: 27f21a9d12117ac4371281ef61628d643e198479
## Summary
`factory run` now walks each ticket through its workflow graph: one session per node, pass, fail and revise edges from the graph, verify always in a new session, and a tier on every brief from the node's pin or `tutor.Policy.Next`. All listed functions are reached by that path or deleted, except `LoadDir`, which `packs/packs_test.go` still calls.
## Acceptance
- `factory run --headless` on porttest fakes walks the default graph (build, verify, done; verify fail back to build; brief carries the tier) -> `TestRunWalksDefaultGraph` in `cmd/factory/workflow_test.go` (pass, verify-fail, student budget spent then large, three fails then needs-human, no models configured) through `newRoot()` and the `newDeps` seam -> done
- A repo workflow file in `.factory/workflows/` replaces the default; an unknown template var fails at load with file and line -> `TestRunHonorsRepoWorkflow` (repo `issue-to-pr.yml` replaces the built-in, pinned tiers win, a ticket's `workflow` names a file), `TestRunRefusesBadWorkflow` (error names `issue-to-pr.yml`, line 8 and the variable), `TestLoadDefault` -> done
- Every listed function reached or deleted, report says which -> see below -> done, with one exception
### Reached by the path
`LoadMarkdown, LoadDefault, splitFrontMatter, checkMarkdownVars, checkNodePrompt, applyFrontMatter, text, parseTrigger, parseSafeOutputs` (WORKFLOW.md and repo default), `Graph.Node, Next, NextWhere, terminal, Nodes` (stage step, load check), `Load, ParseYAML, ParseMarkdown, symphony, child, build, addStep, nextEdges, linkNeeds, validate, noPassLoop, readAgentKeys, tierValue, oldTier, applyAgentsMap, parseTemplate, ValidateTemplate, validateTemplateAt, Render, RenderPrompt`, `tutor.Policy.Next`.
### Deleted
`Graph.CanWrite` (nothing enforces safe outputs), `tutor.Lesson` with `Validate` and `Render` and its golden file (the retro stage files lessons, not the core), the tutor's unread `WriteLesson`, `Verdict` and `ReviewedBy`. `Graph.Describe` became the test helper `describe` for the golden files.
### Kept, blocked
`Graph.LoadDir` (and `Edges`, `Branches`, which deadcode counts as reached): `packs/packs_test.go` and `packs/residue_test.go` call them and are outside my area. The packs session can drop them with its tests.
### Counts
Non-test Go outside `src/`: 20032 before, 20223 after (+191: the stage step, `workflow.go`, minus deletions). Deadcode for graph, tutor and core: 42 before, 1 after (`LoadDir`).
## API change requests
- `api.Brief` has no tier field. I put the tier name ("small" or "large") in `Brief.Model`. Dispatchers (`local`, `routines`, `fire`) must resolve it through config `models.<tier>` before use: `local` passes `Brief.Model` to `--model` as is. The tutor policy turns on only when config sets both `models.small` and `models.large`; a node that pins `tier:` stamps it regardless. Please add `Brief.Tier` and the lookup.
- `config` key `workflow` defaults to `feature-to-pr` (triage, plan, park nodes, conditional edges), which the run loop cannot walk. The loop ignores that key and uses the ticket's `workflow` or the built-in `issue-to-pr`. The key's default should become `issue-to-pr`.
## Files outside my area
- `cmd/factory/control.go`: one line in `newControl`, `d.Stages = stagesFor(cfg)`, so the seam keeps working.
- `internal/core/events.go`, `ports.go`, `control.go`, `core.go`: inside "core (only the stage step)": a `KindStage` event, hooks in Dispatch, Observe and SetPhase(done), and `delete(c.stages, id)` on cancel and escalate.
## Gate evidence
`just` is not installed; I ran the recipe bodies by hand with `GOTOOLCHAIN=go1.26.0`: `gofmt -l .` empty, `go vet ./...` clean, golangci-lint v2.13.2 (`GOTOOLCHAIN=go1.26.7`): `0 issues.` / `lint exit 0`, `go test -race ./...` all `ok` with no FAIL lines, `CGO_ENABLED=0 go build ./cmd/factory` built.
Mutations: ignoring `ChecksGreen` in `advance` turned `TestRunWalksDefaultGraph` red; ignoring a pinned tier turned `TestRunHonorsRepoWorkflow` red; both reverted.
Not done, said plainly: a node's position lives in core memory, so after a restart a ticket resumes at the first node (the issue-thread marker for it is not written). Only agent nodes run; check, human and fanout nodes in a workflow file are refused at load with a clear error. Verify outcome is read from `Observation.ChecksGreen` (red is fail, nil or green is pass); no verdict comment is read. Control.Dispatch and Retry in `internal/core/control.go` were not changed to stamp the node.
## Learnings
- deadcode built by go1.24 refuses a go1.26 module: `GOTOOLCHAIN=go1.26.0 GOBIN=/tmp/gobin go install ...deadcode@v0.39.0`, then run the binary.
- The brief's "default issue-to-pr" did not exist anywhere; the factory should ship that file or name the default in config.
- Deleting API that another area's tests call fails the whole build; the brief should list outside callers (`grep` the repo first).
- `porttest.Observer.Observe` ignores the attempt, so a multi-attempt flow needs a scripted observer in the test.
