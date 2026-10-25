# Agents

The factory runs any coding agent that has a CLI. Seven have a built-in preset; anything else runs as a
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

Install the skills into each agent's own directory with `factory install <repo> --agents claude,gemini`.
Skills stay in `.claude/skills`; the other directories are symlinks to it. A context pointer
(`AGENTS.md`, or `GEMINI.md` for Gemini) is written only when the file is absent.

## What keeps a stage safe, per agent

| Layer | Claude | Codex, Gemini, Cursor, Pi, Mastra Code | OpenCode |
| --- | --- | --- | --- |
| Read-only stages cannot edit files | allow-list | the flag in the table above; the runner writes the artifact | no: stage prompt and gate only |
| Path guard hook | yes | no | no |
| Tool-call cap and timeout | yes | yes | yes |
| Only its own provider API keys in the env (GH_TOKEN and dashboard tokens are always stripped) | yes | yes | yes (all multi-provider keys) |

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

Cursor has no versioned download, so the Docker image cannot pin it: run it on the host. Mistral Vibe,
omp and Amp have no preset; use the `command` form.
