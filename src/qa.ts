// The QA step's result (template/.factory/qa.sh writes qa.json) as a PR body section.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./artifacts";

export interface Qa {
  readonly routes: readonly { readonly path: string; readonly status: number; readonly ok: boolean }[];
}

export function readQa(worktree: string, issue: number): Qa | undefined {
  const file = join(worktree, runDir(issue), "qa.json");
  if (!existsSync(file)) return undefined;
  try {
    const qa = JSON.parse(readFileSync(file, "utf8")) as Qa;
    return Array.isArray(qa.routes) ? qa : undefined;
  } catch {
    return undefined;
  }
}

export function qaSection(qa: Qa): string {
  const rows = qa.routes.map((r) => `| \`${r.path}\` | ${r.status} | ${r.ok ? "ok" : "failed"} |`);
  return ["## QA", "", "| Route | Status | Result |", "| --- | --- | --- |", ...rows].join("\n");
}
