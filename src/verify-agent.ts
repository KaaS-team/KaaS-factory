// `factory verify-agent <name>` and `make agent-matrix`: how a participant proves a
// preset against the seeded splitbill issue. It flips nothing; their PR flips `verified`.

import { resolve } from "node:path";
import { PRESETS } from "./agents/presets";
import type { AgentConfig, StageAgents } from "./agents/types";
import type { StageRun } from "./state";

export interface AgentRunConfig {
  readonly agents: Record<string, AgentConfig>;
  readonly stages: StageAgents;
}

// Fixtures belong to the runner, not the repo it was pointed at: resolved from
// this file, so running verify-agent from a target repo never litters it.
export function defaultFixtureDir(name: string): string {
  return resolve(import.meta.dir, "..", "tests", "fixtures", "agents", name);
}

// Every stage runs on the named preset, whatever the repo's own config says.
export function configFor(name: string): AgentRunConfig {
  if (!PRESETS[name]) throw new Error(`unknown agent "${name}"; presets: ${Object.keys(PRESETS).join(", ")}`);
  return { agents: { [name]: { preset: name } }, stages: { default: name } };
}

export interface VerifyReport {
  readonly agent: string;
  readonly stages: number;
  readonly failedStages: string[];
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly pass: boolean;
}

export function reportFor(agent: string, runs: readonly StageRun[], outcome: string): VerifyReport {
  const failedStages = runs.filter((r) => r.exit_code !== 0 || r.killed_reason).map((r) => r.stage);
  return {
    agent,
    stages: runs.length,
    failedStages,
    costUsd: runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
    tokensIn: runs.reduce((n, r) => n + r.tokens_in, 0),
    tokensOut: runs.reduce((n, r) => n + r.tokens_out, 0),
    durationMs: runs.reduce((n, r) => n + r.duration_ms, 0),
    outcome,
    pass: outcome === "shipped" && failedStages.length === 0 && runs.length > 0,
  };
}

export function formatReport(r: VerifyReport): string {
  const secs = Math.round(r.durationMs / 1000);
  return [
    `${r.pass ? "PASS" : "FAIL"} ${r.agent}: outcome ${r.outcome}, ${r.stages} stages, ${secs}s`,
    `cost $${r.costUsd.toFixed(4)}, tokens ${r.tokensIn} in / ${r.tokensOut} out`,
    ...(r.failedStages.length ? [`failed stages: ${r.failedStages.join(", ")}`] : []),
    r.pass
      ? `Next: commit the recorded fixture and open a PR that sets verified: true on the "${r.agent}" preset.`
      : "Do not flip `verified`; open an issue with this output instead.",
  ].join("\n");
}

// The agents `make agent-matrix` can run here, and the ones it names as skipped.
export async function matrixPlan(
  which: (bin: string) => Promise<boolean>,
): Promise<{ run: string[]; skipped: string[] }> {
  const run: string[] = [];
  const skipped: string[] = [];
  for (const [name, preset] of Object.entries(PRESETS)) ((await which(preset.binary)) ? run : skipped).push(name);
  return { run, skipped };
}
