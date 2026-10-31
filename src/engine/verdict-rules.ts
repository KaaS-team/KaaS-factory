// The runner owns the verdict's heading and round, and three reject causes the model gets wrong:
// a proof that failed only to compile, a reject of should findings alone, and files changed
// outside an imported plan. It also holds the last reject's findings until verify resolves each.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runDir, type Finding, type PlanArtifact, type VerdictArtifact } from "../artifacts";
import { isTrusted } from "../chatops";
import { parseDataMarkers } from "../derive";
import type { ProofResult, ProofStatus } from "../proof";
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
  if (runner.length === 0) return body;
  return `${body.trimEnd()}\n\n### Runner findings\n${runner.map((f) => `- ${f.what}`).join("\n")}\n`;
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
    const what = `Findings from the last reject are not marked resolved: ${open.join("; ")}`;
    verdict = {
      ...verdict,
      findings: [...verdict.findings, { severity: "could", confidence: 5, what, where: "runner" }],
    };
  }
  if (open.length > 0 && verdict.result === "pass") return { ...verdict, result: "uncertain" };
  return verdict;
}

// Set once a run has sent its off-plan rebuild, so the next round does not repeat it.
const offPlanSentRuns = new WeakSet<RunCtx>();

const mustWhats = (v: VerdictArtifact): string[] =>
  v.findings.flatMap((f) => (typeof f === "string" ? [f] : f.severity === "must" ? [f.what] : []));

export async function settleVerdict(sc: StepCtx, verdict: VerdictArtifact): Promise<VerdictArtifact> {
  if (verdict.outcome === "blocked" || verdict.outcome === "failed") return verdict;
  const { worktree, config, deps, issue, ctx } = sc;
  const proof = readRunJson<ProofResult>(worktree, issue.number, "proof.json");
  const plan = readRunJson<PlanArtifact & { source?: string }>(worktree, issue.number, "plan.json");
  const prior = readRunJson<string[]>(worktree, issue.number, "prior-findings.json") ?? [];
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
  out = applyPriorFindings(out, prior);
  if (out.findings.some((f) => typeof f !== "string" && f.what.startsWith(OFF_PLAN))) offPlanSentRuns.add(ctx);
  const file = `${worktree}/${runDir(issue.number)}/prior-findings.json`;
  if (out.result === "reject") writeFileSync(file, JSON.stringify(mustWhats(out), null, 2));
  else if (out.result === "pass" && existsSync(file)) rmSync(file);
  return out;
}
