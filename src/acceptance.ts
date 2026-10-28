// The PR body's "Acceptance" table, one row per spec criterion, rendered from the kit's
// scripts/kaas/check-acceptance.py --json. The script owns the verdict; this only runs it and shows what it
// said, so a reviewer reads each promise beside its proof. A repo without the script gets no table.
// A verdict that is not proven rejects verify, as a failing holdout does.

import { existsSync } from "node:fs";
import { holdoutEnabled, type FactoryConfig } from "./config";
import { shq } from "./core/frame";
import type { ExecutionPort } from "./ports/execution";

export const ACCEPTANCE_SCRIPT = "scripts/kaas/check-acceptance.py";
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

export function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function proof(row: AcceptanceRow): string {
  if (!row.holdout.length) return "no holdout";
  if (!row.new) return row.head === "pass" ? "holds" : "fails on the branch";
  if (row.base === "pass") return "already passed before the change";
  return row.head === "pass" ? "fails before, passes after" : "fails on the branch";
}

export function renderAcceptanceTable(v: AcceptanceVerdict): string {
  return `## Acceptance\n\n${acceptanceRows(v)}`;
}

function acceptanceRows(v: AcceptanceVerdict): string {
  const lines: string[] = [];
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
  return lines.join("\n").replace(/^\n/, "");
}

// The PR body's Acceptance section. The criteria are this issue's own, from its plan.json, each with
// verify's status for it. The kit checks every spec in the repo, so its rows join only for the one spec
// plan.json names; an unrelated spec's criteria once filled a PR's table on their own (#90).
export function renderPlanAcceptance(
  plan: { readonly criteria?: unknown; readonly spec?: unknown } | undefined,
  verified: readonly { readonly id: string; readonly status: string }[] | undefined,
  kit: AcceptanceVerdict | undefined,
): string {
  const criteria = Array.isArray(plan?.criteria)
    ? (plan.criteria as unknown[]).filter(
        (c): c is { id: string; text: string } =>
          typeof c === "object" &&
          c !== null &&
          typeof (c as { id?: unknown }).id === "string" &&
          typeof (c as { text?: unknown }).text === "string",
      )
    : [];
  const lines = ["## Acceptance", ""];
  if (criteria.length) {
    const status = new Map((verified ?? []).map((c) => [c.id, c.status]));
    lines.push(
      "| Criterion | Verify |",
      "|---|---|",
      ...criteria.map((c) => `| ${c.id}: ${cell(c.text)} | ${status.get(c.id) ?? "not checked"} |`),
    );
  } else lines.push("This issue's plan.json names no criteria.");
  const spec = typeof plan?.spec === "string" ? plan.spec : undefined;
  if (spec && kit) {
    const others = new Set(kit.acs.map((r) => r.spec).filter((s) => s !== spec));
    const own: AcceptanceVerdict = {
      ...kit,
      acs: kit.acs.filter((r) => r.spec === spec),
      errors: kit.errors.filter((e) => ![...others].some((o) => e.includes(o))),
    };
    lines.push("", `### Holdouts for ${cell(spec)}`, "", acceptanceRows(own));
  }
  return lines.join("\n");
}

// The kit checks every spec in the repo; verify answers only for the criteria this plan names. No
// criteria in the plan keeps the whole verdict, and a filter that leaves nothing to say returns undefined.
export function planAcceptance(
  kit: AcceptanceVerdict,
  plan: { readonly criteria?: unknown; readonly spec?: unknown } | undefined,
): AcceptanceVerdict | undefined {
  const ids = new Set(
    (Array.isArray(plan?.criteria) ? (plan.criteria as unknown[]) : []).flatMap((c) =>
      typeof c === "object" && c !== null && typeof (c as { id?: unknown }).id === "string"
        ? [(c as { id: string }).id]
        : [],
    ),
  );
  if (!ids.size) return kit;
  const spec = typeof plan?.spec === "string" ? plan.spec : undefined;
  const kept = kit.acs.filter((r) => ids.has(r.ac) && (!spec || r.spec === spec));
  const dropped = kit.acs.filter((r) => !kept.includes(r));
  const errors = kit.errors.filter((e) => !dropped.some((r) => e.includes(`${r.spec} ${r.ac}`)));
  return kept.length || errors.length ? { ...kit, acs: kept, errors } : undefined;
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
