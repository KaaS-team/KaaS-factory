// The runner owns the verdict's heading and round, and three reject causes the model gets wrong:
// a proof that failed only to compile, a reject of should findings alone, and files changed
// outside an imported plan. It also holds the last reject's findings until verify resolves each.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runDir, type Finding, type PlanArtifact, type VerdictArtifact } from "../artifacts";
import { isTrusted } from "../chatops";
import { parseDataMarkers } from "../derive";
import type { ProofResult, ProofStatus } from "../proof";
import { mergeLedger, openWhats, seedLedger, type LedgerRow } from "../finding-ledger";
import type { RunCtx } from "./common";
import type { StepCtx } from "./steps";

export function readRunJson<T>(worktree: string, issueNumber: number, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(`${worktree}/${runDir(issueNumber)}/${name}`, "utf8")) as T;
  } catch {
    return undefined; // the stage that writes it did not run
  }
}

export function verdictHeading(result: string, round: number, limit: number): string {
  const suffix = result === "reject" ? ` (round ${round} of ${limit})` : "";
  return `## Verdict: ${result}${suffix}`;
}

export function withVerdictHeading(comment: string, heading: string): string {
  const rest = comment
    .split("\n")
    .filter((l) => !l.startsWith("<!-- factory:verdict") && !l.startsWith("## Verdict"))
    .join("\n")
    .replace(/^\s*\n/, "")
    .replace(/^(\s*\n)+/, "");
  return `<!-- factory:verdict v1 -->\n${heading}\n\n${rest}`;
}

const isRunner = (f: string | Finding): f is Finding => typeof f !== "string" && f.where === "runner";

export function verdictPost(
  comment: string,
  verdict: VerdictArtifact | undefined,
  round: number,
  limit: number,
): string {
  if (!verdict?.result) return comment;
  const body = withVerdictHeading(comment, verdictHeading(verdict.result, round, limit));
  const runner = verdict.findings.filter(isRunner);
  const table = criteriaTable(verdict.criteria);
  const withTable = table ? `${body.trimEnd()}\n\n${table}\n` : body;
  if (runner.length === 0) return withTable;
  return `${withTable.trimEnd()}\n\n### Runner findings\n${runner.map((f) => `- ${f.what}`).join("\n")}\n`;
}

const STATUS_WORD = { pass: "met", fail: "not met", unverified: "unverified" } as const;

// Every requirement ID the verdict carries, with its status, so none is lost in free text.
export function criteriaTable(criteria: VerdictArtifact["criteria"]): string {
  if (!criteria?.length) return "";
  const rows = criteria.map((c) => `| ${c.id} | ${STATUS_WORD[c.status]} | ${c.gap ?? ""} |`);
  return `### Requirement IDs\n\n| ID | Status | Gap |\n| --- | --- | --- |\n${rows.join("\n")}`;
}

const runnerFinding = (what: string): Finding => ({ severity: "must", confidence: 5, what, where: "runner" });
const OFF_PLAN = "Files changed outside the plan:";

const flag = (v: VerdictArtifact, result: "reject" | "uncertain", f: Finding): VerdictArtifact => ({
  ...v,
  result,
  findings: [...v.findings, f],
});
const COMPILE_ONLY =
  "The proof failed only because the reverted tree does not compile; add a test that fails on the change's behaviour without it.";

const PASSES_WITHOUT =
  "The new tests still pass with the implementation reverted, so they do not prove the change; write a test that fails without it.";

export function applyVerdictRules(
  verdict: VerdictArtifact,
  facts: {
    proof?: ProofStatus;
    plan?: { files?: string[]; source?: string };
    changed: string[];
    offPlanSent: boolean;
  },
): VerdictArtifact {
  if (facts.proof === "compile-only" && verdict.result === "pass")
    verdict = flag(verdict, "reject", runnerFinding(COMPILE_ONLY));
  if (facts.proof === "passes-without" && verdict.result === "pass")
    verdict = flag(verdict, "reject", runnerFinding(PASSES_WITHOUT));
  if (facts.plan?.source === "issue") {
    const planned = new Set(facts.plan.files ?? []);
    const off = facts.changed.filter((f) => !f.startsWith(".factory/") && !planned.has(f));
    if (off.length > 0 && !facts.offPlanSent)
      verdict = flag(verdict, "reject", runnerFinding(`${OFF_PLAN} ${off.join(", ")}`));
  }
  if (
    verdict.result === "reject" &&
    verdict.findings.length > 0 &&
    verdict.findings.every((f) => typeof f !== "string" && f.severity !== "must")
  )
    return { ...verdict, result: "uncertain" };
  return verdict;
}

export function applyPriorFindings(verdict: VerdictArtifact, prior: readonly string[]): VerdictArtifact {
  const status = new Map((verdict.prior ?? []).map((p) => [p.what, p.status]));
  const open = prior.filter((w) => status.get(w) !== "resolved");
  if (open.length > 0 && verdict.result === "pass") {
    const what = `Open findings from earlier rejects (${open.length}) are not marked resolved: ${open.join("; ")}`;
    verdict = {
      ...verdict,
      findings: [...verdict.findings, { severity: "could", confidence: 5, what, where: "runner" }],
    };
  }
  if (open.length > 0 && verdict.result === "pass") return { ...verdict, result: "uncertain" };
  return verdict;
}

// A plan criterion the verdict never names is unverified, and unverified is not a pass; the
// schema only catches criteria the verdict lists, so a verdict that drops one would pass.
export function applyPlanCriteria(
  verdict: VerdictArtifact,
  planned: readonly { readonly id: string }[] | undefined,
): VerdictArtifact {
  if (verdict.result !== "pass" || !planned?.length) return verdict;
  const said = new Map((verdict.criteria ?? []).map((c) => [c.id, c.status]));
  const known = new Set(planned.map((c) => c.id));
  const unmatched = [...said.keys()].filter((id) => !known.has(id));
  const open = planned.map((c) => c.id).filter((id) => said.get(id) !== "pass");
  if (!open.length && !unmatched.length) return verdict;
  const gap = "the verdict does not mark it met";
  const added = open.filter((id) => !said.has(id)).map((id) => ({ id, status: "unverified" as const, gap }));
  const parts = [
    open.length ? `Plan criteria not marked met: ${open.join(", ")}` : "",
    unmatched.length ? `Verdict names IDs the plan does not have: ${unmatched.join(", ")}` : "",
  ];
  const what = parts.filter(Boolean).join(". ");
  return {
    ...verdict,
    result: "uncertain",
    criteria: [...(verdict.criteria ?? []), ...added],
    findings: [...verdict.findings, { severity: "could", confidence: 5, what, where: "runner" }],
  };
}

// Set once a run has sent its off-plan rebuild, so the next round does not repeat it.
const offPlanSentRuns = new WeakSet<RunCtx>();

export async function settleVerdict(sc: StepCtx, verdict: VerdictArtifact): Promise<VerdictArtifact> {
  if (verdict.outcome === "blocked" || verdict.outcome === "failed") return verdict;
  const { worktree, config, deps, issue, ctx } = sc;
  const proof = readRunJson<ProofResult>(worktree, issue.number, "proof.json");
  const plan = readRunJson<PlanArtifact & { source?: string }>(worktree, issue.number, "plan.json");
  const prior = readRunJson<string[]>(worktree, issue.number, "prior-findings.json") ?? [];
  let ledger = readRunJson<LedgerRow[]>(worktree, issue.number, "findings-ledger.json");
  if (!ledger) ledger = seedLedger(prior);
  const changed = await deps.git.changedFiles(worktree, config.base);
  const sentBefore = parseDataMarkers(issue.comments.filter(isTrusted)).some(
    (m) =>
      m.stage === "verify" &&
      ((m.json as VerdictArtifact | undefined)?.findings ?? []).some(
        (f) => typeof f !== "string" && f.what.startsWith(OFF_PLAN),
      ),
  );
  const offPlanSent = offPlanSentRuns.has(ctx) || sentBefore;
  let out = applyVerdictRules(verdict, { proof: proof?.status, plan, changed, offPlanSent });
  out = applyPriorFindings(out, openWhats(ledger));
  out = applyPlanCriteria(out, plan?.criteria);
  if (out.findings.some((f) => typeof f !== "string" && f.what.startsWith(OFF_PLAN))) offPlanSentRuns.add(ctx);
  const runPath = `${worktree}/${runDir(issue.number)}`;
  const merged = mergeLedger(ledger, out);
  writeFileSync(`${runPath}/findings-ledger.json`, JSON.stringify(merged, null, 2));
  const file = `${runPath}/prior-findings.json`;
  if (out.result === "reject") writeFileSync(file, JSON.stringify(openWhats(merged), null, 2));
  else if (out.result === "pass" && existsSync(file)) rmSync(file);
  return out;
}
