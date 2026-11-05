// `factory plan-order`: the order the scheduler dispatches in, its critical path, and why each
// issue that is not ready waits. Read-only; the order itself comes from src/core/schedule.ts.

import type { CliContext } from "./cli-runtime";
import { parseMeta, type SchedNode, schedule } from "./core/schedule";
import { loadConfig } from "./config";
import type { GhIssue } from "./github";
import { LABEL } from "./labels";
import { makeScm } from "./scm";

export function planOrderLines(issues: readonly GhIssue[]): string[] {
  const metas = new Map(
    issues
      .map((i) => [i, parseMeta(i.body ?? "")] as const)
      .filter(([i, m]) => m.declared || i.labels.some((l) => l.name === LABEL.ready || l.name === LABEL.blocked))
      .map(([i, m]) => [i.number, { issue: i, meta: m }] as const),
  );
  const nodes: SchedNode[] = [...metas].map(([number, { meta: m }]) => ({
    number,
    deps: m.deps,
    files: [],
    runner: m.runner,
    ...(m.epic ? { epic: m.epic } : {}),
    ...(m.milestone ? { milestone: m.milestone } : {}),
  }));
  const plan = schedule({ nodes, open: new Set(issues.map((i) => i.number)), slots: nodes.length });
  const title = (n: number) => metas.get(n)?.issue.title ?? "";
  const lines = ["Order"];
  plan.order.forEach((n, k) => lines.push(`${k + 1}. #${n} ${title(n)}`));
  lines.push("", `Critical path: ${plan.criticalPath.map((n) => `#${n}`).join(" -> ") || "none"}`, "", "Waiting");
  const waiting = nodes.map((n) => n.number).filter((n) => !plan.ready.includes(n));
  for (const n of waiting) lines.push(plan.why[n] ?? `#${n} waits`);
  if (waiting.length === 0) lines.push("nothing");
  return lines;
}

export async function cmdPlanOrder(cli: CliContext): Promise<void> {
  const dir = await cli.resolveCloneDir();
  const config = await loadConfig(dir);
  for (const line of planOrderLines(await makeScm(config).listOpenIssues(config.repo))) console.log(line);
}
