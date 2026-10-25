// The PR body's "Acceptance" table, one row per spec criterion, rendered from the kit's
// scripts/lwp/check-acceptance.py --json. The script owns the verdict; this only runs it and shows what it
// said, so a reviewer reads each promise beside its proof. A repo without the script gets no table.
// A verdict that is not proven rejects verify, as a failing holdout does.

import { existsSync } from "node:fs";
import { holdoutEnabled, type FactoryConfig } from "./config";
import { shq } from "./core/frame";
import type { ExecutionPort } from "./ports/execution";

export const ACCEPTANCE_SCRIPT = "scripts/lwp/check-acceptance.py";
const REPO_JSON = [".agents/repo.json", ".claude/repo.json"];

export interface AcceptanceRow {
  readonly spec: string;
  readonly ac: string;
  readonly text: string;
  readonly holdout: readonly string[];
  readonly new: boolean;
  readonly base?: "pass" | "fail";
  readonly head: "pass" | "fail";
  readonly ok: boolean;
}

export interface AcceptanceVerdict {
  readonly base: string | null;
  readonly acs: readonly AcceptanceRow[];
  readonly errors: readonly string[];
}

export async function runAcceptance(
  exec: ExecutionPort,
  worktree: string,
  base: string,
): Promise<AcceptanceVerdict | undefined> {
  if (!existsSync(`${worktree}/${ACCEPTANCE_SCRIPT}`)) return undefined;
  const out = await exec.run(`python3 ${ACCEPTANCE_SCRIPT} --json --base ${shq(`origin/${base}`)}`, worktree);
  try {
    return JSON.parse(out.stdout) as AcceptanceVerdict;
  } catch {
    // A crash prints no JSON; the table then says so rather than vanishing.
    const tail = `${out.stdout}\n${out.stderr}`.trim().slice(-300);
    return { base, acs: [], errors: [`check-acceptance exited ${out.code} without a verdict: ${tail}`] };
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 160);
}

function proof(row: AcceptanceRow): string {
  if (!row.holdout.length) return "no holdout";
  if (!row.new) return row.head === "pass" ? "holds" : "fails on the branch";
  if (row.base === "pass") return "already passed before the change";
  return row.head === "pass" ? "fails before, passes after" : "fails on the branch";
}

export function renderAcceptanceTable(v: AcceptanceVerdict): string {
  const lines = ["## Acceptance", ""];
  if (v.acs.length) {
    lines.push(
      "| Spec | Criterion | Holdout | Proof | |",
      "|---|---|---|---|---|",
      ...v.acs.map(
        (r) =>
          `| ${cell(r.spec)} | ${r.ac}: ${cell(r.text)} | ${cell(r.holdout.join(", ") || "none")} | ${proof(r)} | ${r.ok ? "pass" : "FAIL"} |`,
      ),
    );
  }
  const failed = v.acs.filter((r) => !r.ok).length;
  if (v.errors.length) lines.push("", ...v.errors.map((e) => `- ${cell(e)}`));
  lines.push(
    "",
    v.errors.length || failed || !v.acs.length
      ? `Not proven: ${failed} of ${v.acs.length} criteria failed, ${v.errors.length} problem(s).`
      : `All ${v.acs.length} criteria proven.`,
  );
  return lines.join("\n");
}

export function acceptanceProven(v: AcceptanceVerdict): boolean {
  return v.acs.length > 0 && !v.errors.length && v.acs.every((r) => r.ok);
}

// The paths no stage's agent may see: config.holdout.paths, plus the kit's acceptance holdout folder when
// the base branch vendors check-acceptance.py. Read from origin/<base>, never the worktree, so a branch
// that edits repo.json cannot unhide its own holdouts. One list feeds the sparse checkout, the build's
// protected paths and the guard hook (FACTORY_HIDDEN_PATHS).
export async function hiddenPaths(exec: ExecutionPort, config: FactoryConfig, worktree: string): Promise<string[]> {
  const paths = holdoutEnabled(config.holdout) ? [...config.holdout.paths] : [];
  const ref = shq(`origin/${config.base}`);
  const script = await exec.run(`git cat-file -e ${ref}:${ACCEPTANCE_SCRIPT}`, worktree);
  if (script.code !== 0) return paths;
  for (const name of REPO_JSON) {
    const shown = await exec.run(`git show ${ref}:${name}`, worktree);
    if (shown.code !== 0) continue;
    let dir: unknown;
    try {
      const acceptance = (JSON.parse(shown.stdout) as { acceptance?: { holdout?: unknown } }).acceptance;
      if (!acceptance) return paths;
      dir = acceptance.holdout ?? "holdout";
    } catch {
      return paths;
    }
    if (typeof dir === "string" && dir.trim()) paths.push(`${dir.replace(/^\/+|\/+$/g, "")}/**`);
    return paths;
  }
  return paths;
}
