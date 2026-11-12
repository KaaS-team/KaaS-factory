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
- `contrib/agents/codex.ts` from `internal/runner/codex_usage.go` [tested by `tests/ported/machinist/usage.test.ts`]
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

## ossf/scorecard@4ddc782c70ebba1d65f0dd1b3470f24ed4ea18b1

Source: https://github.com/ossf/scorecard (Apache-2.0, Copyright OpenSSF Scorecard Authors)

- `internal/firstrun/sarif/annotations.go` from `config/annotations.go` [no upstream test]
- `internal/firstrun/sarif/sarif.go` from `pkg/scorecard/sarif.go` (result, rule and level shapes) [no upstream test]

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

- `contrib/agents/mastracode-flags.ts` from `mastracode/sdk/src/headless/flags.ts` [tested by `tests/ported/mastra/flags.test.ts`]

## browser-use/browser-use@dfb6a73

Source: https://github.com/browser-use/browser-use (MIT, Copyright (c) 2024 Gregor Zunic)

- `internal/browsercheck/settle.go` from `browser_use/ax.py` (`settle`, `PROBE_JS` reduced to ready and idle)
- `internal/browsercheck/profile.go` from `browser_use/browser/local.py` (`SKIP_COPY`, `copy_profile`, `_try_lock`, `sweep_stale_dirs`)
- `internal/browsercheck/secrets.go` from `browser_use/repl/session.py` (`secret_forms`, `redact_forms`) and `browser_use/repl/worker.py` (`type_secret`)

## OpenHands/software-agent-sdk@10be259

Source: https://github.com/OpenHands/software-agent-sdk (MIT, Copyright (c) 2026 OpenHands contributors). Only the stuck detector was ported; `openhands-sdk/` outside `ee/` directories.

- `internal/dispatch/local/stuck/stuck.go` from `openhands-sdk/openhands/sdk/conversation/stuck_detector.py` [tested by `internal/dispatch/local/stuck/stuck_test.go`]

## block/goose@910d084

Source: https://github.com/block/goose (Apache-2.0, Copyright Block, Inc.)

- `internal/packs/retry.go` from `crates/goose/src/agents/retry.rs` and `agents/types.rs` (RetryConfig, SuccessCheck) [tested by `internal/packs/retry_test.go`]
- `internal/packs/manifest.go` from `crates/goose/src/recipe/validate_recipe.rs` (parameter caps only) [tested by `internal/packs/manifest_test.go`]

## OpenHands/software-agent-sdk@10be259c4fc89b23999e8c653f2130a358e02116

Source: https://github.com/OpenHands/software-agent-sdk (MIT, Copyright (c) 2026 OpenHands contributors)

- `internal/packs/triggers.go` from `openhands-sdk/openhands/sdk/skills/skill.py` (path glob, keyword match, trigger selection) [tested by `internal/packs/triggers_test.go`]
## e2b-dev/E2B@3e72be3

Source: https://github.com/e2b-dev/E2B (Apache-2.0). Licence text: https://www.apache.org/licenses/LICENSE-2.0. The Go port keeps the rationale and the character rule, not the code.

- `pkg/sandbox/egress/names.go` from `packages/js-sdk/src/sandbox/iam.ts` (`validateIamTokenName`) [upstream has no test for it; `pkg/sandbox/egress/secrets_test.go` has one row per clause of its doc comment]

## OpenHands/software-agent-sdk@10be259

Source: https://github.com/OpenHands/software-agent-sdk (MIT, Copyright (c) 2026 OpenHands contributors). The MIT permission notice above applies, with this copyright line in place of the one it carries.

- `pkg/sandbox/egress/mask.go` from `openhands-sdk/openhands/sdk/conversation/secret_registry.py` (`StreamOutputMask`, `mask_secrets_in_output`) [tests ported in spirit from `tests/sdk/agent/test_stream_context.py`; fixtures in `pkg/sandbox/egress/mask_test.go`]

## Aider-AI/aider@5dc9490

Source: https://github.com/Aider-AI/aider (Apache-2.0, Copyright (c) Paul Gauthier). The ranking and budget search of `aider/repomap.py` are ported to Go; the tree-sitter `.scm` query files are not copied (they need CGO).

- `internal/packs/repomap/tags.go` from `aider/repomap.py` [tested by `internal/packs/repomap/repomap_test.go`]
- `internal/packs/repomap/rank.go` from `aider/repomap.py` [tested by `internal/packs/repomap/repomap_test.go`]
- `internal/packs/repomap/budget.go` from `aider/repomap.py` [tested by `internal/packs/repomap/repomap_test.go`]
## ast-grep/ast-grep@c7e005c

Source: https://github.com/ast-grep/ast-grep (MIT, Copyright (c) 2022 Herrington Darkholme). Only field lists and output formats were read; no Rust was ported. The release binary is pinned by checksum, not vendored.

- `internal/packs/astgrep/astgrep.go` from `crates/cli/src/print/json_print.rs` [tested by `internal/packs/astgrep/astgrep_test.go`]
- `internal/packs/astgrep/pack.go` from `crates/config/src/rule_config.rs` and `crates/cli/src/verify/reporter.rs` [tested by `internal/packs/astgrep/pack_test.go`]
## continuedev/continue@5522c6f

Source: https://github.com/continuedev/continue (Apache-2.0, Copyright 2023 Continue Dev, Inc.). Logic was ported to Go and rewritten, not pasted; the prompt scope rules are reworded.

- `internal/packs/checkmd/pack.go` from `core/llm/rules/getSystemMessageWithRules.ts` (glob, regex and colocation applicability) [tested by `internal/packs/checkmd/pack_test.go`]
- `internal/packs/checkmd/run.go` from `extensions/cli/src/commands/review/worktree.ts` and the prompt block of `reviewWorker.ts` [tested by `internal/packs/checkmd/run_test.go`]
## cline/cline@50e77bc1e8f7ab023b7986821e4b5f82ff51b8c4

Source: https://github.com/cline/cline (Apache License 2.0, Copyright Cline Bot Inc.). The full
licence text is at https://www.apache.org/licenses/LICENSE-2.0 and in the upstream `LICENSE` file at
this commit. The files below are ported to Go and changed from the originals.

- `internal/gitx/checkpoint/checkpoint.go` from `sdk/packages/core/src/hooks/checkpoint-hooks.ts` and `sdk/packages/core/src/session/checkpoint-restore.ts` [tested by `internal/gitx/checkpoint/checkpoint_test.go`]

## triggerdotdev/trigger.dev@2fbd5c7

Source: https://github.com/triggerdotdev/trigger.dev (Apache-2.0, Copyright Trigger.dev)

- `internal/pick/fair.go` from `packages/redis-worker/src/fair-queue/schedulers/drr.ts` (algorithm only, in process, no Redis or Lua) [tested by `internal/pick/fair_test.go`]

## SWE-bench/SWE-bench@02e7a74

Source: https://github.com/SWE-bench/SWE-bench (MIT, Copyright (c) 2023 Carlos E Jimenez, John Yang, Alexander Wettig, Shunyu Yao, Kexin Pei, Ofir Press, Karthik R Narasimhan)

- `internal/eval/infra/infra.go` from `swebench/harness/infra_failure.py` [no upstream test]

## sourcegraph/zoekt@9e78667

Source: https://github.com/sourcegraph/zoekt (Apache-2.0)

- `internal/packs/category.go` from `index/file_category.go` [tested by `internal/packs/category_test.go`]

## onlook-dev/onlook@423e2e9

Source: https://github.com/onlook-dev/onlook (Apache-2.0; the LICENSE is kept at `packs/design/LICENSE`, upstream ships no NOTICE, ours is `packs/design/NOTICE`)

- `packs/design/src/packages.js` from `packages/parser/src/packages.ts` [no upstream test]
- `packs/design/src/helpers.js` from `packages/parser/src/helpers.ts` and `packages/parser/src/code-edit/helpers.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/parse.js` from `packages/parser/src/parse.ts` [tested by `packs/design/test/parser.test.js`]
- `packs/design/src/ids.js` from `packages/parser/src/ids.ts` [tested by `packs/design/test/parser.test.js`]
- `packs/design/src/style.js` from `packages/parser/src/code-edit/style.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/text.js` from `packages/parser/src/code-edit/text.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/move.js` from `packages/parser/src/code-edit/move.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/remove.js` from `packages/parser/src/code-edit/remove.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/insert.js` from `packages/parser/src/code-edit/insert.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/transform.js` from `packages/parser/src/code-edit/transform.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/src/dynamic.js` from `packages/parser/src/template-node/map.ts` [tested by `packs/design/test/edits.test.js`]
- `packs/design/test/data/` from `packages/parser/test/data/{ids,parse}` [tested by `packs/design/test/parser.test.js`]

## continuedev/continue@5522c6f

Source: https://github.com/continuedev/continue (Apache-2.0, Copyright (c) Continue Dev, Inc.).

- `internal/review/worktree.go` from `extensions/cli/src/commands/review/worktree.ts` [tested by `internal/review/review_test.go`]

## coder/agentapi@7c468d5

Source: https://github.com/coder/agentapi (MIT, Copyright (c) 2025 Coder Technologies, Inc.)

- `internal/dispatch/local/input/ringbuffer.go` from `lib/screentracker/ringbuffer.go` [no upstream test; `internal/dispatch/local/input/gate_test.go`]

The bracketed-paste framing, the SIGINT-then-kill close and the stability gate are written after
`lib/httpapi/claude.go`, `lib/termexec/termexec.go` and `lib/screentracker` and copy none of their code.

- `internal/eval/grade/grade.go` from `swebench/harness/grading.py` (Go port; truncated-id prefix match dropped)
- `internal/eval/grade/markers.go` from `swebench/harness/constants/__init__.py`
- `internal/eval/grade/parse.go` from `swebench/harness/log_parsers/python.py` (pytest parser; the go test parser is ours)

## coder/agentapi@7c468d5

Source: https://github.com/coder/agentapi (MIT, Copyright (c) 2025 Coder Technologies, Inc.). The licence text above applies; the notice is kept with the copied code.

- `internal/serve/hostguard/hostguard.go` from `lib/httpapi/server.go` (parseAllowedHosts, parseAllowedOrigins, hostAuthorizationMiddleware; huma and chi dropped) [tested by `internal/serve/hostguard/hostguard_test.go`]

## anthropics/claude-code-action@8a29bc6

Source: https://github.com/anthropics/claude-code-action (MIT, Copyright (c) 2025 Anthropic, PBC)

- `internal/tracker/github/trigger.go` from `src/github/validation/trigger.ts`, `src/github/validation/actor.ts` and `src/github/utils/actor-filter.ts` [ported to Go; tested by `internal/tracker/github/trigger_test.go`]

```
MIT License

Copyright (c) 2025 Anthropic, PBC

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
```

## langfuse/langfuse@2e6d034

Source: https://github.com/langfuse/langfuse (MIT, Copyright (c) 2023-2026 ClickHouse, Inc.; files outside `ee/` only)

- `internal/observe/sampling/sampling.go` from `worker/src/features/evaluation/deterministicSampling.ts` (domain string changed) [tested by `internal/observe/sampling/sampling_test.go`]
- `internal/meter/price/matcher.go` from `packages/shared/src/server/pricing-tiers/matcher.ts` [cases in `matcher_test.go`]
- `internal/meter/price/cost.go` from `packages/shared/src/server/pricing-tiers/calculateModelUsageCosts.ts` [cases ported from `calculateModelUsageCosts.test.ts` in `cost_test.go`]
- `internal/meter/price/catalog.json` is `worker/src/constants/default-model-prices.json` filtered to Anthropic and OpenAI models, tokenizer fields dropped.

MIT License

Copyright (c) 2023-2026 ClickHouse, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## dagger/dagger@835b0ef806b277fb216735a180d1a542c2937024

Source: https://github.com/dagger/dagger (Apache-2.0, Copyright The Dagger Authors).

- `internal/eval/replay/replay.go` from `core/llm_recording.go` (algorithm and diff shape; re-implemented against our message type, no go-cmp) [tested by `internal/eval/replay/replay_test.go`]
- `internal/eval/replay/scrub.go` from `util/scrub/scrub.go` (regex table and `Stabilize` only; Dagger rules replaced with ours) [tested by `internal/eval/replay/scrub_test.go`]

## dagger/dagger@835b0ef

Source: https://github.com/dagger/dagger (Apache-2.0, Copyright 2022 Dagger, Inc.). The licence text is `LICENSES/Apache-2.0.txt`. Dagger's NOTICE file reads: "This product includes software developed at Dagger, Inc. (https://www.dagger.io)."

- `pkg/sandbox/cachevol/store.go` from `engine/cachevolumedir/store.go`, with the Dagger naming removed, a tenant field added to the identity, and the test hooks dropped [tested by `pkg/sandbox/cachevol/store_test.go`]
