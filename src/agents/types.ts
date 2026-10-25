// The factory knows no agent by name. An agent is config (a command, or a
// preset that fills one in) plus an optional line parser for the numbers.

import type { StageEvent, StageName, StageRunOptions } from "../executor";

export interface AgentConfig {
  // A built-in preset ("claude", "codex"); it supplies the command and parser.
  readonly preset?: string;
  // Any other CLI: argv with {{prompt}}, {{promptFile}} and {{model}} placeholders.
  // With no placeholder the prompt goes to stdin.
  readonly command?: readonly string[];
  readonly model?: string;
  // Pass the reply schema to the CLI (Codex --output-schema). Off until a live run confirms the CLI accepts it.
  readonly outputSchema?: boolean;
}

// stages.default is the agent for every stage; a stage name overrides it.
export type StageAgents = Partial<Record<StageName | "default", string>>;

// What a stage may do to the worktree. Triage, plan and verify only read;
// build writes code, and pr writes the PR body and pr.json.
export interface StagePolicy {
  readonly write: boolean;
}

export function stagePolicy(stage: StageName): StagePolicy {
  return { write: stage === "build" || stage === "pr" };
}

// Extra things the executor hands a preset for one stage.
export interface StageContext {
  // A JSON Schema file for the agent's final message (only when opted in).
  readonly schemaFile?: string;
  // The --mcp-config file holding this run's servers (only for a preset with `mcp: true`).
  readonly mcpConfig?: string;
}

export interface StageInvocation {
  readonly argv: readonly string[];
  readonly stdin?: string;
}

export interface AgentPreset {
  readonly name: string;
  // The binary `factory doctor` looks for.
  readonly binary: string;
  // True once a recorded live run passed (a fixture in tests/fixtures/agents/<name>/). Only Claude is verified by the maintainers; the rest are verified by participants (docs/verify-an-agent.md).
  readonly verified: boolean;
  // The CLI version the Dockerfile and CI pin; `factory doctor` warns on drift.
  readonly version: string;
  // Provider keys this agent may see. Every other known provider key is stripped from its env.
  readonly envKeys: readonly string[];
  // Set on every stage run of this agent, after the parent env is sanitized.
  readonly env?: Readonly<Record<string, string>>;
  // What keeps a read-only stage read-only for this agent (shown in docs/agents.md).
  readonly readOnlyBy: string;
  // Project directory `install --agents` links the skills into, and the context file it points at.
  readonly skillsDir: string;
  readonly contextFile: string;
  // True when the CLI has no --version (Mastra Code treats it as a prompt); doctor skips the drift check.
  readonly noVersionFlag?: true;
  // False when the agent cannot be pinned in the Docker image (no versioned download).
  readonly docker?: false;
  // How the CLI takes the prompt, and the research line that shows it (checked by tests/agents-registry.test.ts). Claude owns its prompt and has neither.
  readonly promptVia?: "stdin" | "argv";
  readonly evidence?: string;
  // Builds argv and stdin. `prompt` is the rendered stage prompt.
  command(opts: StageRunOptions, agent: AgentConfig, prompt: string, ctx?: StageContext): StageInvocation;
  // True when a read-only stage cannot write its files: the agent returns them
  // as its final message and the runner writes them (see reply.ts).
  readonly returnsArtifact?: boolean;
  // Starts the MCP servers in ctx.mcpConfig. A step that names servers refuses any other agent.
  readonly mcp?: true;
  parseLine(line: string): StageEvent[];
  // For a CLI whose events span lines: a fresh stateful parser per stage run (used instead of parseLine).
  newParser?(): (line: string) => StageEvent[];
  // True for a line (or its first bytes) that would have been the terminal usage event.
  isUsageCandidate(line: string): boolean;
  // Claude runs the repo's `/factory-<stage>` skill itself; others get the skill body inlined.
  readonly ownsPrompt?: boolean;
}

// Where the runner tells the agent to put its files.
export const ARTIFACT_ENV = ["FACTORY_ARTIFACT_DIR", "FACTORY_ISSUE", "FACTORY_STAGE", "FACTORY_SCRATCH_DIR"] as const;
