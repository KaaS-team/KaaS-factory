# Third-party notices

Code ported from other projects. Each ported file starts with a `Ported from` header naming the
upstream repo, commit, path and lines; `tests/provenance.test.ts` keeps this file and those headers
in step. Only MIT and Apache-2.0 code is copied; mastra's `ee/` directories are never read or copied.

## owainlewis/machinist@3943516

Source: https://github.com/owainlewis/machinist (MIT, Copyright (c) 2026 Owain Lewis)

- `dashboard/public/styles.css` from `internal/controlplane/web/src/styles.css` [no upstream test]
- `dashboard/public/lib/run-metrics.js` from `internal/controlplane/web/src/run-metrics.js` [tested by `tests/ported/machinist/run-metrics.test.ts`]
- `dashboard/public/lib/runs-board.js` from `internal/controlplane/web/src/runs-board.js` [tested by `tests/ported/machinist/runs-board.test.ts`]
- `dashboard/public/lib/status-loader.js` from `internal/controlplane/web/src/status-loader.js` [tested by `tests/ported/machinist/status-ui.test.ts`]
- `dashboard/public/lib/analytics-state.js` from `internal/controlplane/web/src/analytics-state.js` [no upstream test]
- `dashboard/public/lib/task-presentation.js` from `internal/controlplane/web/src/task-presentation.js` [tested by `tests/ported/machinist/task-presentation.test.ts`]
- `dashboard/public/lib/routes.js` from `internal/controlplane/web/src/routes.js` [tested by `tests/ported/machinist/routes.test.ts`]
- `src/revision.ts` from `internal/runner/revision.go` (shape from `internal/protocol/revision.go`) [tested by `tests/ported/machinist/revision.test.ts`]
- `src/agents/executor.ts` from `internal/runner/runner.go` (process group kill from `process_unix.go`) [tested by `tests/ported/machinist/runner.test.ts`]
- `src/agents/env.ts` from `internal/runner/runner.go` [tested by `tests/ported/machinist/runner.test.ts`]
- `src/event-budget.ts` from `internal/runner/events.go` [tested by `tests/ported/machinist/events.test.ts`]
- `src/agents/structured.ts` from `internal/runner/codex_usage.go` [tested by `tests/ported/machinist/structured.test.ts`]
- `src/agents/final-message.ts` from `internal/runner/codex_usage.go` [tested by `tests/ported/machinist/final-message.test.ts`]
- `src/agents/presets/codex.ts` from `internal/runner/codex_usage.go` [tested by `tests/ported/machinist/usage.test.ts`]
- `src/agents/usage.ts` from `internal/runner/codex_usage.go` [tested by `tests/ported/machinist/usage.test.ts`]
- `src/artifacts.ts` from `internal/protocol/workflow.go` [tested by `tests/ported/machinist/workflow.test.ts`]
- `template/.claude/skills/factory-operator/SKILL.md` from `skills/machinist/SKILL.md` [no upstream test]
- `src/ci.ts` from `agent.py:439-459,487-592` [tested by `tests/ported/machinist/ci.test.ts`]
- `src/merge-policy.ts` from `risk_delivery/gate.py` [tested by `tests/ported/machinist/merge-policy.test.ts`]

## owainlewis/assembler@7cac671

Source: https://github.com/owainlewis/assembler (MIT, Copyright (c) 2026 Owain Lewis)

- `src/display.ts` from `src/display.ts` [tested by `tests/ported/assembler/display.test.ts`]
- `src/logs.ts` from `src/runs.ts` [tested by `tests/ported/assembler/logs.test.ts`]
- `src/config.ts` from `src/index.ts` [tested by `tests/ported/assembler/config.test.ts`]
- `src/agents/reply.ts` from `src/index.ts` [tested by `tests/ported/assembler/outputs.test.ts`]

## owainlewis/skills@e8cadb3

Source: https://github.com/owainlewis/skills (MIT, Copyright (c) 2026 Owain Lewis)

- `src/agent-dirs.ts` from `internal/agents/agents.go` [tested by `tests/ported/skills/agents.test.ts`]

## owainlewis/blueprint@54c952b

Source: https://github.com/owainlewis/blueprint (MIT, Copyright (c) 2026 Owain Lewis)

- `src/docs-links.ts` from `scripts/check_repo.py` [tested by `tests/ported/blueprint/check_repo.test.ts`]

## owainlewis/agent-skills@766699e

Source: https://github.com/owainlewis/agent-skills (MIT, Copyright (c) 2026 Owain Lewis)

Referenced, not copied: the herdr-issue-coordinator merge-gate checklist (`skills/herdr-issue-coordinator/SKILL.md:209-226`) informed `src/merge-policy.ts`'s ten named refusal reasons; see that file's own header for the deviation note.

## License text (both projects)

MIT License

Copyright (c) 2026 Owain Lewis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Geist (font)

`dashboard/public/fonts/geist.woff2` is Geist (Copyright 2024 The Geist Project Authors,
https://github.com/vercel/geist-font), SIL Open Font License 1.1, copied from kaas.team. The licence
text ships beside it as `LICENSE-geist.txt`.

## mastra-ai/mastra@68fece5

Source: https://github.com/mastra-ai/mastra (Apache-2.0, Copyright (c) 2025 Kepler Software, Inc.). Only `mastracode/` was used; the licence excludes `ee/` directories and none was read.

- `src/agents/presets/mastracode-flags.ts` from `mastracode/sdk/src/headless/flags.ts` [tested by `tests/ported/mastra/flags.test.ts`]
