// The dependency half of the pre-launch plan check (plan-guard.ts runs first): a planned body's header
// "Deps:" line and each task's "Deps:" line may name `#N` or `#N Tn`. A `#N` is met once that issue is
// closed as completed; a `#N Tn` is also met once every file task Tn of that issue lists exists on main.

import type { GhIssue, ScmPort } from "./github";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DepRef {
  readonly issue: number;
  readonly task?: string;
}

// Only the header (before the first `## `) and `### T<n>` chunks are read, so prose elsewhere never counts.
export function depRefs(body: string): DepRef[] {
  const chunks = [body.split(/^## /m)[0] ?? ""];
  for (const chunk of body.split(/^### /m).slice(1)) chunks.push(chunk.split(/^## /m)[0]!);
  const refs = new Map<string, DepRef>();
  for (const chunk of chunks) {
    const line = /^Deps:[ \t]*(.+)$/im.exec(chunk)?.[1] ?? "";
    for (const m of line.matchAll(/#(\d+)(?:[ \t]+(T\d+))?/g)) {
      const ref = { issue: Number(m[1]), ...(m[2] ? { task: m[2] } : {}) };
      refs.set(`${ref.issue}/${ref.task ?? ""}`, ref);
    }
  }
  return [...refs.values()];
}

// The backticked paths on task `id`'s "Files:" line in a planned body.
function taskFiles(body: string, id: string): string[] {
  const chunk = body.split(/^### /m).find((c) => c.startsWith(`${id}:`)) ?? "";
  const line = /^Files:.*$/im.exec(chunk)?.[0] ?? "";
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
}

const label = (r: DepRef) => `#${r.issue}${r.task ? ` ${r.task}` : ""}`;

// One reason per unmet dependency, naming it. An issue that cannot be fetched counts as unmet.
export async function unmetDeps(body: string, github: ScmPort, repo: string, main: string): Promise<string[]> {
  const reasons: string[] = [];
  for (const ref of depRefs(body)) {
    const dep: GhIssue | undefined = await github.getIssue(repo, ref.issue).catch(() => undefined);
    if (dep?.state === "CLOSED" && dep.stateReason !== "NOT_PLANNED") continue;
    const files = ref.task ? taskFiles(dep?.body ?? "", ref.task) : [];
    if (files.length > 0 && files.every((f) => existsSync(join(main, f)))) continue;
    reasons.push(
      `Dependency ${label(ref)} is not merged: ${ref.task ? "the issue is open and its files are not on main" : "the issue is not closed"}.`,
    );
  }
  return reasons;
}
