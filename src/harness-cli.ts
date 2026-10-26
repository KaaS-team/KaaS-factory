// `factory harness` and `factory teach`, kept out of cli.ts. cli.ts hands over its flag readers and
// the two builders that need its process wiring (the watch deps and the state file).

import { resolve } from "node:path";
import { EXIT, UsageError, successJson } from "./cli-output";
import { type FactoryConfig, loadConfig } from "./config";
import { evalRuns, formatInventory, formatScores, harnessReport, scaffoldWorkflow } from "./harness";
import { FactoryState } from "./state";
import { runTeach, type TeachDeps } from "./teach";

export interface CliContext {
  readonly args: readonly string[];
  flag(name: string): string | undefined;
  has(name: string): boolean;
  cloneDir(): Promise<string>;
  watchDeps(cloneDir: string, config: FactoryConfig): Promise<TeachDeps>;
  statePath(repo: string): string;
}

const USAGE =
  "usage: factory harness (validate | inventory | scaffold <name> | eval [--since <days>]) --repo-dir <path> [--json]";
// Every run.completed of a busy repo fits; older runs are what --since leaves out anyway.
const EVAL_WINDOW = 100_000;

export async function cmdHarness(c: CliContext): Promise<void> {
  const sub = c.args[1];
  const dir = resolve(c.flag("repo-dir") ?? ".");
  if (sub === "scaffold") return scaffold(c, dir);
  if (sub === "eval") return evaluate(c, dir);
  if (sub !== "validate" && sub !== "inventory") throw new UsageError(USAGE);
  const report = await harnessReport(dir, await loadConfig(dir));
  if (c.has("json")) {
    console.log(
      successJson(
        {
          problems: report.problems,
          workflows: report.entries.map(({ workflow, ...e }) => ({
            ...e,
            steps: workflow ? Object.keys(workflow.steps) : [],
          })),
        },
        sub === "inventory" || !report.problems.length,
      ),
    );
  } else if (sub === "inventory") {
    for (const line of formatInventory(report)) console.log(line);
  } else {
    for (const p of report.problems) console.log(`factory harness: ${p}`);
    if (!report.problems.length) console.log(`factory harness: ${report.entries.length} workflows, all valid`);
  }
  if (sub === "validate" && report.problems.length) process.exit(EXIT.checksFailed);
}

function scaffold(c: CliContext, dir: string): void {
  const name = c.args[2];
  if (!name || name.startsWith("--")) throw new UsageError(USAGE);
  const out = scaffoldWorkflow(dir, name);
  if (c.has("json")) console.log(successJson(out, "path" in out));
  else if ("path" in out) console.log(`factory harness: wrote ${out.path}; edit it, then run factory harness validate`);
  else for (const p of out.problems) console.log(`factory harness: ${p}`);
  if ("problems" in out) process.exit(EXIT.checksFailed);
}

async function evaluate(c: CliContext, dir: string): Promise<void> {
  const config = await loadConfig(dir);
  const days = Number(c.flag("since") ?? 30);
  if (!Number.isFinite(days) || days <= 0) throw new UsageError("--since takes a number of days");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const state = new FactoryState(c.statePath(config.repo));
  try {
    const rows = state.busEvents(EVAL_WINDOW).filter((r) => r.time >= since);
    const scores = evalRuns(rows, config.repo, (i) => state.spendSummary(config.repo, since, i).costUsd);
    if (c.has("json")) console.log(successJson({ since, workflows: scores }, true));
    else for (const line of formatScores(scores)) console.log(`factory harness: ${line}`);
  } finally {
    state.close();
  }
}

export async function cmdTeach(c: CliContext): Promise<void> {
  const how = c.args[1];
  if (!how || how.startsWith("--"))
    throw new UsageError('usage: factory teach "<how we ship>" (--repo-dir <path> | --repo <owner/name>) [--json]');
  const cloneDir = await c.cloneDir();
  const config = await loadConfig(cloneDir);
  const out = await runTeach(await c.watchDeps(cloneDir, config), config, how);
  if (c.has("json")) console.log(successJson(out, "prUrl" in out));
  else if ("prUrl" in out) console.log(`factory teach: proposed ${out.files.join(", ")} -> ${out.prUrl}`);
  else for (const p of out.problems) console.log(`factory teach: ${p}`);
  if ("problems" in out) process.exit(EXIT.checksFailed);
}
