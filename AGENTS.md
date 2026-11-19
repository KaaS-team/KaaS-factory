# KaaS Factory

Plans work into tickets and runs them on parallel coding-agent sessions, then lands them through a
merge queue. Go v9. The TypeScript line is deleted; tag `ts-final` holds it.

## Gate

`just check` is the gate: gofmt, vet, golangci-lint, `go test -race`, static build, ratchet. CI and the
pre-push hook run it. `./gate.sh` does the same without `just`. `just fast` skips race and lint; run it
before every push. It must end with zero errors and zero warnings.

## Boundaries

- `internal/api` is the one contract. The CLI, TUI, MCP and dashboard reach the core only through
  `Control` and `Event`.
- A copied file starts with `// Ported from <repo>@<sha> <path>`, MIT or Apache-2.0 only, with a section in
  `THIRD_PARTY_NOTICES.md` (`internal/provenance` test).
- No provider key anywhere. Token counts, cost and model names stay out of PR bodies and customer views.
- Cloud sessions cannot push `.github/workflows/**`.

## Package map

| Path | Holds |
|---|---|
| `cmd/factory` | the `factory` CLI |
| `internal/api` | the contract and its ports |
| `internal/core` | the planner, loop and state |
| `internal/plan`, `internal/plancmd` | plan DAG and `factory plan` |
| `internal/mergeq` | the merge queue |
| `internal/dispatch` | session runners: local, cloud, untrusted |
| `internal/mcp` | the MCP server |
| `internal/dashboard`, `internal/tui` | the board views |
| `internal/config` | layered config |
| `internal/firstrun` | `factory first-run` |
| `internal/eval` | evals |
| `pkg/agentrun`, `pkg/sandbox`, `pkg/retry` | public packages |
| `ee` | enterprise code, its own licence |
| `tools/ratchet`, `tools/gate`, `tools/prcheck`, `tools/doccheck` | repo checks |
| `packs`, `template`, `evals` | pack, skill and eval data |
| `docs` | guides; `docs/demo` holds demo output |

`tools/doccheck` fails when a backticked path in `README.md` or `AGENTS.md` does not exist.
