// Running the factory with no long-lived watcher: `factory dispatch` names the issues one tick would
// advance, as an Actions matrix (one `factory run --issue N` job each), and `factory routine` writes
// a Claude Code cloud routine that runs `factory tick` on a schedule.

import { appendFileSync } from "node:fs";
import { resolveBlockers } from "./blockers";
import { parseCron } from "./core/cron";
import type { ScmPort } from "./github";
import { LABEL } from "./labels";
import { canServe } from "./machine";

// The labels pollOnce lists (src/watch.ts); tests/dispatch.test.ts pins the two together.
export const INTAKE_LABELS = [LABEL.ready] as const;
export const RESUME_LABELS = [
  LABEL.needsInfo,
  LABEL.awaitingApproval,
  LABEL.failed,
  LABEL.needsHuman,
  LABEL.inReview,
] as const;

export interface DispatchJob {
  readonly issue: number;
  readonly label: string;
}

export interface Dispatch {
  readonly jobs: DispatchJob[];
  readonly paused?: string;
}

export async function dispatchJobs(
  github: ScmPort,
  repo: string,
  opts: { maxOpenFactoryPrs: number; capabilities?: readonly string[] },
): Promise<Dispatch> {
  const open = (await github.listPrs(repo, { state: "open" })).filter((p) => p.headRefName.startsWith("factory/"));
  const paused =
    open.length >= opts.maxOpenFactoryPrs
      ? `STOP_IF: ${open.length} factory PRs open in review (limit ${opts.maxOpenFactoryPrs})`
      : undefined;
  // Same intake as a tick: a blocked ready issue is demoted, not dispatched.
  const ready = paused
    ? []
    : (
        await resolveBlockers(
          github,
          repo,
          await github.listIssuesByLabel(repo, LABEL.ready),
          await github.listIssuesByLabel(repo, LABEL.blocked),
        )
      ).clear;
  const resumed = await Promise.all(RESUME_LABELS.map((l) => github.listIssuesByLabel(repo, l)));
  const seen = new Set<number>();
  const jobs: DispatchJob[] = [];
  for (const [label, issues] of [
    [LABEL.ready, ready] as const,
    ...RESUME_LABELS.map((l, i) => [l, resumed[i]!] as const),
  ])
    for (const issue of issues) {
      if (seen.has(issue.number) || !canServe(opts.capabilities, issue.labels)) continue;
      seen.add(issue.number);
      jobs.push({ issue: issue.number, label });
    }
  jobs.sort((a, b) => a.issue - b.issue);
  return paused ? { jobs, paused } : { jobs };
}

// What a later `strategy: matrix: ${{ fromJSON(needs.dispatch.outputs.matrix) }}` reads.
export function writeActionsOutput(dispatch: Dispatch, outputFile: string | undefined): void {
  if (!outputFile) return;
  const matrix = JSON.stringify({ include: dispatch.jobs.map((j) => ({ issue: j.issue })) });
  appendFileSync(outputFile, `matrix=${matrix}\ncount=${dispatch.jobs.length}\n`);
}

export interface CloudRoutine {
  readonly name: string;
  readonly cron: string;
  readonly prompt: string;
}

export function cloudRoutine(opts: {
  repo: string;
  runnerRepo: string;
  runnerRef: string;
  cron?: string;
}): CloudRoutine {
  const cron = opts.cron ?? "*/30 * * * *";
  parseCron(cron);
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`routine: "${opts.repo}" is not owner/name`);
  const prompt = [
    `Run one KaaS Factory tick on ${opts.repo}. Change no file and open no PR yourself; the factory does that.`,
    `1. git clone --depth 1 --branch ${opts.runnerRef} https://github.com/${opts.runnerRepo}.git "$HOME/.factory-runner"`,
    `2. (cd "$HOME/.factory-runner" && bun install --frozen-lockfile)`,
    `3. bun "$HOME/.factory-runner/bin/factory" tick --repo ${opts.repo} --json`,
    "4. Reply with the JSON line it printed. If it exits non-zero, reply with the last 20 lines of its output.",
  ].join("\n");
  return { name: `factory tick ${opts.repo}`, cron, prompt };
}
