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
import { type FactoryConfig, type GateSpec, gateCount, testGate } from "./config";
import type { Git } from "./git";
import { detectConventions, diskConventionFiles, type Tool } from "./conventions";
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
  // A gate that could not run says nothing about the build, so it is unknown, never red.
  const upper = status.toUpperCase();
  return {
    status: (upper === "MISCONFIGURED" ? "UNKNOWN" : upper) as GateResult["status"],
    passed: Number(passed),
    failed: Number(failed),
    skipped: Number(skipped),
    failedGates: failedGates && failedGates !== "-" ? failedGates.split(",").filter(Boolean) : [],
    raw: match[0],
  };
}

export class ShellGateRunner implements GateRunner {
  // `setup` is config.setup. A remote runtime gets a bare copy of the worktree with no installed
  // dependencies, so its setup commands run first, in the same directory as the gates.
  // Each entry is one simple command: they are joined with `&&`, so `||` or `;` would change precedence.
  constructor(
    private readonly exec: ExecutionPort = new LocalExecution(),
    private readonly setup: readonly string[] = [],
  ) {}
  async run(worktreeDir: string) {
    const port = worktreePort(worktreeDir);
    const gates = `${port ? `FACTORY_PORT=${port} ` : ""}bash .factory/gates.sh`;
    const remote = !(this.exec instanceof LocalExecution);
    const pre = remote && this.setup.length > 0 ? [...this.setup, ""].join(" && ") : "";
    const result = await this.exec.run(`${pre}${gates}`, worktreeDir);
    const tools = missingTools(worktreeDir);
    if (tools.length === 0 || !parseGateLine(`${result.stdout}\n${result.stderr}`)) return result;
    const failed: string[] = [];
    let passed = 0;
    let out = result.stdout;
    for (const tool of tools) {
      const cmd = await this.toolCommand(tool, worktreeDir);
      if (cmd === undefined) continue;
      const r = await this.exec.run(`${pre}${cmd}`, worktreeDir);
      if (r.code === 127) continue; // not installed: says nothing about the build
      const name = `${tool.role}`;
      out += `\n--- detected ${tool.role}: ${tool.name} ---\n${r.code === 0 ? `PASS: ${name}` : `FAIL: ${name}\n${r.stdout}${r.stderr}`.slice(-1500)}`;
      if (r.code === 0) passed++;
      else failed.push(name);
    }
    const line = parseGateLine(`${result.stdout}\n${result.stderr}`)?.raw ?? "";
    const folded = addToLine(line, passed, failed);
    return { ...result, stdout: out.replace(line, folded), stderr: result.stderr.replace(line, folded) };
  }

  // A format check reads only the files the change touched; the others run on the whole repo.
  private async toolCommand(tool: Tool, dir: string): Promise<string | undefined> {
    if (!tool.cmd.includes("{files}")) return tool.cmd;
    const files = await changedFormatFiles(this.exec, dir, tool.exts ?? []);
    return files.length === 0 ? undefined : tool.cmd.replace("{files}", files.map((f) => `'${f}'`).join(" "));
  }
}

// Tools the repo configures for a role that .factory/config.json has no gate for, so a repo's own
// formatter, linter and type checker run even when init found no script for them.
export function missingTools(dir: string): Tool[] {
  let roles = new Set<string>();
  try {
    const cfg = JSON.parse(readFileSync(join(dir, ".factory", "config.json"), "utf8")) as { gates?: GateSpec[] };
    roles = new Set((cfg.gates ?? []).map((g) => g.role ?? g.name));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return detectConventions(diskConventionFiles(dir)).tools.filter((t) => {
    if (roles.has(t.role) || seen.has(t.role)) return false;
    seen.add(t.role);
    return true;
  });
}

async function changedFormatFiles(exec: ExecutionPort, dir: string, exts: readonly string[]): Promise<string[]> {
  let base = "main";
  try {
    base = (JSON.parse(readFileSync(join(dir, ".factory", "config.json"), "utf8")) as { base?: string }).base ?? base;
  } catch {}
  const b = process.env.FACTORY_GATES_BASE ?? `origin/${base}`;
  const r = await exec.run(
    `{ git diff --name-only ${b}...HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u`,
    dir,
  );
  return r.stdout
    .split("\n")
    .filter((f) => f && !f.includes("'") && exts.some((e) => f.endsWith(e)) && existsSync(join(dir, f)));
}

// Folds the detected tools' results into the one FACTORY_GATES line, so a format diff makes it RED.
export function addToLine(output: string, passed: number, failed: readonly string[]): string {
  const g = parseGateLine(output);
  if (!g) return output;
  const names = [...g.failedGates, ...failed];
  const status = g.status === "UNKNOWN" ? "UNKNOWN" : names.length > 0 ? "RED" : g.status;
  return `FACTORY_GATES: status=${status} passed=${g.passed + passed} failed=${g.failed + failed.length} skipped=${g.skipped} failed_gates=${names.join(",") || "-"}`;
}

export async function runGates(gateRunner: GateRunner, worktreeDir: string): Promise<GateResult> {
  const result = await gateRunner.run(worktreeDir);
  const combined = `${result.stdout}\n${result.stderr}`;
  const parsed = parseGateLine(combined);
  if (parsed) return parsed;
  return {
    status: "UNKNOWN",
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

// A workflow stage's `gates: [names]` runs only those gates (it becomes `FACTORY_GATES_ONLY=a,b`).
// A build that edits template/** can break a test in another file (#497), so such a diff adds the test
// gate, which runs the whole suite, to the list.
const ONLY = "FACTORY_GATES_ONLY=";

export function touchesTemplate(changed: readonly string[]): boolean {
  return changed.some((f) => f.startsWith("template/"));
}

// The gate names to run: `names`, plus the test gate when the diff touches template/**.
export function gateList(names: readonly string[], changed: readonly string[], gates: readonly GateSpec[]): string[] {
  const test = testGate(gates)?.name;
  return touchesTemplate(changed) && test !== undefined && !names.includes(test) ? [...names, test] : [...names];
}

// A check step's command, with the test gate added to a named-gates run when the diff needs it. Any
// other command comes back as it was, and the diff is read only for a named-gates run.
export async function scopeGateRun(
  run: string,
  git: Pick<Git, "changedFiles">,
  worktree: string,
  config: Pick<FactoryConfig, "base" | "gates">,
): Promise<string> {
  if (!run.startsWith(ONLY)) return run;
  const space = run.indexOf(" ");
  const names = run.slice(ONLY.length, space < 0 ? run.length : space).split(",");
  const list = gateList(names, await git.changedFiles(worktree, config.base), config.gates);
  return `${ONLY}${list.join(",")}${space < 0 ? "" : run.slice(space)}`;
}
