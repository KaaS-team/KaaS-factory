// The runner is the only thing that decides a build is green — the agent's
// own build.json claim is informative, never authoritative (audit finding
// #11: "the writer doesn't grade its own work"). This runs the target's own
// `.factory/gates.sh` directly and parses the one line it's contracted to
// print: `FACTORY_GATES: status=... passed=N failed=N skipped=N failed_gates=a,b`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionPort } from "./ports/execution";
import type { GateResult, GateRunner } from "./ports/check";
import { LocalExecution } from "./adapters/local/execution";
import { gateCount } from "./config";
import { worktreePort } from "./port";
export type { GateResult, GateRunner };

const LINE_RE = /FACTORY_GATES:\s*status=(\w+)\s+passed=(\d+)\s+failed=(\d+)\s+skipped=(\d+)\s+failed_gates=(\S*)/;

export function parseGateLine(output: string): GateResult | undefined {
  const match = output.match(LINE_RE);
  if (!match) return undefined;
  const [, status, passed, failed, skipped, failedGates] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    status: status.toUpperCase() as GateResult["status"],
    passed: Number(passed),
    failed: Number(failed),
    skipped: Number(skipped),
    failedGates: failedGates && failedGates !== "-" ? failedGates.split(",").filter(Boolean) : [],
    raw: match[0],
  };
}

export class ShellGateRunner implements GateRunner {
  constructor(private readonly exec: ExecutionPort = new LocalExecution()) {}
  run(worktreeDir: string) {
    const port = worktreePort(worktreeDir);
    return this.exec.run(`${port ? `FACTORY_PORT=${port} ` : ""}bash .factory/gates.sh`, worktreeDir);
  }
}

export async function runGates(gateRunner: GateRunner, worktreeDir: string): Promise<GateResult> {
  const result = await gateRunner.run(worktreeDir);
  const combined = `${result.stdout}\n${result.stderr}`;
  const parsed = parseGateLine(combined);
  if (parsed) return parsed;
  return {
    status: "MISCONFIGURED",
    passed: 0,
    failed: 0,
    skipped: 0,
    failedGates: ["gates.sh produced no FACTORY_GATES line"],
    raw: combined.slice(-2000),
  };
}

// True when the worktree's config lists no gates, so no build there can ever go
// green. Checked before the build agent runs, so it costs no tokens. A missing or
// unreadable config is left to gates.sh, which names it.
export function hasNoGates(worktreeDir: string): boolean {
  const file = join(worktreeDir, ".factory", "config.json");
  if (!existsSync(file)) return false;
  try {
    return gateCount(JSON.parse(readFileSync(file, "utf8"))) === 0;
  } catch {
    return false;
  }
}

export const NO_GATES_COMMENT = `This repo has no gates in \`.factory/config.json\`, so no build here can be checked, and the factory parked this issue instead of building it.

Add a gate: run \`factory init\` to detect the stack and write them, or add one by hand. A docs-only repo can ship with one lint or link-check gate. Then move this issue back to \`factory:ready\`.`;
