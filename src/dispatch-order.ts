// The order the watcher dispatches in: the scheduler's (src/core/schedule.ts), not issue number.
// Blocked issues join the graph so a ready issue that unblocks others ranks by its critical path.
// An issue with no Deps/Epic/Milestone/Runner line keeps its numeric place among the others.

import { orderIssues, parseMeta, type SchedNode, schedule } from "./core/schedule";
import type { GhIssue } from "./github";

export function schedulerOrder(candidates: readonly GhIssue[], waiting: readonly GhIssue[] = []): GhIssue[] {
  const metas = new Map([...waiting, ...candidates].map((i) => [i.number, parseMeta(i.body ?? "")]));
  const nodes: SchedNode[] = [...metas].map(([number, m]) => ({
    number,
    deps: m.deps,
    files: [],
    runner: m.runner,
    ...(m.epic ? { epic: m.epic } : {}),
    ...(m.milestone ? { milestone: m.milestone } : {}),
  }));
  const plan = schedule({ nodes, open: new Set(metas.keys()), slots: nodes.length });
  return orderIssues(candidates, plan, (i) => metas.get(i.number)!.declared);
}
