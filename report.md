BRANCH: go/frontmatter
HEAD: 851582ccefd44a2bf5fd8eeaa2bba8665e0761fd
## Summary
Added `graph.LoadMarkdown` (front matter keys name, on, agent, model_tier, budget, nodes, safe_outputs; body is the default prompt) and `graph.LoadDefault` (root WORKFLOW.md, else `.factory/workflows/feature-to-pr.yml`). Template variables are checked at load with the file line.
## Acceptance
- Markdown and equivalent YAML load to equal graphs -> TestLoadMarkdownEqualsYAML -> done
- Unknown template variable fails naming variable and line -> TestLoadMarkdownTemplateVariables -> done (line given for the body; a node-level prompt error names the variable and step, without a line)
- Missing safe_outputs is an empty write list; unknown kind fails -> TestLoadMarkdownSafeOutputs -> done
- Root WORKFLOW.md is default, else existing default stays -> TestLoadDefault -> done
- Existing 18-workflow test passes -> TestEveryExistingWorkflowLoads -> done
## API change requests
none
## Files outside my area
none (all changes are in internal/graph/)
## Gate evidence
`just` is not installed here, so I ran its recipe bodies by hand: gofmt -l, go vet ./..., golangci-lint v2.13.2, go test -race ./..., CGO_ENABLED=0 go build ./cmd/factory. All exited 0. Last lines:
ok  	github.com/KaaS-team/factory/internal/tracker/linear	1.050s
ok  	github.com/KaaS-team/factory/internal/tracker/vendorkit	1.073s
## Learnings
- The full gate takes over 2 minutes with a cold lint download; run it in the background from the start.
- `on` is optional (defaults to manual) so a bare Symphony WORKFLOW.md loads; the brief did not say whether it is required.
- build() now takes a prompt-check func so markdown nodes can use ticket.* variables; ValidateTemplate's KnownVars (issue, attempt, node, workflow) differ from the ticket's (ticket.title, ticket.body, attempt).
- Ported nothing from gh-aw (no network use); the design follows the ticket's shapes only. Symphony 5.1, 5.2, 5.4 cited in tests.
