# Agent Client Protocol v1: what the bridge relies on

Source: agentclientprotocol.com (protocol overview, prompt turn, tool calls, agents list), read 2026-10-26 through Context7.

- The bridge takes the prompt on stdin and sends it as one `session/prompt` text block; the ACP server itself speaks JSON-RPC over its own stdin and stdout.
- Sequence: `initialize` (protocolVersion 1, no fs or terminal capability), `session/new` (cwd, no MCP servers), `session/prompt`, which answers with a `stopReason`.
- Version negotiation: the agent answers `initialize` with the protocolVersion it picked, and a client that does not speak it must disconnect. `src/agents/acp-client.ts`, the one module that speaks ACP, refuses any version but 1 before opening a session.
- `session/update` notifications carry `agent_message_chunk` (text) and `tool_call` (with a `kind`: read, edit, delete, move, search, execute, think, fetch, other).
- `session/request_permission` asks before a tool runs, with options of kind allow_once, allow_always, reject_once and reject_always. An agent may run some tools without asking, which is why read-only stages under ACP rely on the agent.
- `usage` on the prompt response is an optional field (inputTokens, outputTokens, cachedReadTokens); an agent that omits it reports no tokens.
- Agents listed as ACP servers include Codex through ACP's adapter (`codex-acp`), Gemini CLI, Goose, OpenCode and Claude through Zed's SDK adapter.
