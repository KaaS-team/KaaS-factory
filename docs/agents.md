# Agents

The factory runs any coding agent that has a CLI or speaks ACP. Eight have a built-in preset; anything else runs as a
custom `command`. Only Claude is verified live by the maintainers. The others are verified by
participants ([verify an agent](verify-an-agent.md)), so `factory doctor` warns until a real fixture
backs them.

<!-- agents-table:start -->
| Agent | Binary | Pinned version | Verified live | Read-only stages held by | API keys it may see | Skills dir | Docker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | `2.1.286` | yes | the stage allow-list under `dontAsk` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `.claude/skills` | pinned |
| `codex` | `codex` | `0.156.1` | not yet | `-s read-only` | `OPENAI_API_KEY` | `.codex/skills` | pinned |
| `gemini` | `gemini` | `0.61.0` | not yet | `--approval-mode plan` | `GEMINI_API_KEY`, `GOOGLE_API_KEY` | `.gemini/skills` | pinned |
| `opencode` | `opencode` | `1.18.32` | not yet | `--agent plan` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` | `.opencode/skills` | pinned |
| `cursor` | `cursor-agent` | `2026.01.23-916f423` | not yet | `--mode plan` | `CURSOR_API_KEY` | `.cursor/skills` | host only |
| `pi` | `pi` | `0.73.1` | not yet | `--tools read,grep,find,ls` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` | `.pi/skills` | pinned |
| `mastracode` | `mastracode` | `0.42.0` | not yet | `--mode plan` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` | `.mastracode/skills` | pinned |
| `acp` | `bun` | `1` | not yet | the bridge refusing non-read permission requests | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CURSOR_API_KEY`, `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` | `.agents/skills` | host only |
<!-- agents-table:end -->

The table is generated from the presets (`bun scripts/gen-agents-doc.ts`); a test fails when it drifts.

## Choose agents

`.factory/config.json` names the agents and which stage each one runs:

```json
{
  "agents": { "claude": { "preset": "claude" }, "gemini": { "preset": "gemini", "model": "gemini-3-pro" } },
  "stages": { "default": "claude", "verify": "gemini" }
}
```

### The cheapest model that is enough

An agent can name a model per tier: `"models": { "small": "<cheap model>", "large": "<strong model>" }`.
After triage, each stage reads the issue's risk and file count from the plan (or the triage, before
there is a plan). Low risk with at most 3 files runs on `small`; high risk or 11 files and more runs
on `large`; anything else, and triage itself, runs on `model`. A tier left out falls back to `model`.
The thresholds are `SMALL_MAX_FILES` and `LARGE_MIN_FILES` in `src/core/model-tier.ts`.
Each verify reject moves the rebuild one tier up (`small`, then `model`, then `large`), so a cheap
model that failed is not asked again. Only markers on trusted comments (owner, member, collaborator)
are read, so an outside commenter cannot pick the model.

Install the skills into each agent's own directory with `factory install <repo> --agents claude,gemini`.
Skills stay in `.claude/skills`; the other directories are symlinks to it. A context pointer
(`AGENTS.md`, or `GEMINI.md` for Gemini) is written only when the file is absent.

## What keeps a stage safe, per agent

| Layer | Claude | Codex, Gemini, Cursor, Pi, Mastra Code | OpenCode | ACP |
| --- | --- | --- | --- | --- |
| Read-only stages cannot edit files | allow-list | the flag in the table above; the runner writes the artifact | no: stage prompt and gate only | only if the agent asks permission first; the runner writes the artifact |
| Path guard hook | yes | no | no | no |
| Tool-call cap and timeout | yes | yes | yes | yes |
| Only its own provider API keys in the env (GH_TOKEN and dashboard tokens are always stripped) | yes | yes | yes (all multi-provider keys) | yes (all multi-provider keys) |

Everything else the runner does (the gate, plan approval, the verdict) is agent-independent.

## Bring your own agent

Any CLI that takes a prompt works as a `command`. Placeholders: `{{prompt}}`, `{{promptFile}}`,
`{{model}}`. With none, the prompt goes to stdin. The agent gets `FACTORY_ARTIFACT_DIR`,
`FACTORY_ISSUE`, `FACTORY_STAGE` and `FACTORY_SCRATCH_DIR`, and writes each stage's files into
`FACTORY_ARTIFACT_DIR`. Worked example with aider:

```json
{
  "agents": { "aider": { "command": ["aider", "--yes-always", "--no-auto-commits", "--message-file", "{{promptFile}}"] } },
  "stages": { "default": "aider" }
}
```

With no preset the factory cannot read tokens or count tool calls, so usage shows "not reported"
and the timeout is the only cap. `factory doctor` says so.

## Agents that speak ACP

The `acp` preset runs any Agent Client Protocol server: put its argv in `command`, and the bridge in
`src/agents/acp-bridge.ts` starts a session, sends the stage prompt and turns the session updates into
the runner's events. For example, Codex through ACP's adapter:

```json
{
  "agents": { "codex-acp": { "preset": "acp", "command": ["codex-acp"] } },
  "stages": { "default": "codex-acp" }
}
```

A read-only stage refuses every permission request that is not a read, search or think, so it holds
only for an agent that asks before it edits; the gate and plan approval still apply. The agent picks its
own model, tokens show only when it reports `usage`, and the bridge runs on the host, not in Docker.

Cursor has no versioned download, so the Docker image cannot pin it: run it on the host. Mistral Vibe,
omp and Amp have no preset; use the `command` form.
