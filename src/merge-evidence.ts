// Evidence for raising a repo's autonomy: how often the agent reviewers and the human review
// agree. mergeContext records one entry per PR; evidenceReport reads them. Read-only: it changes
// no setting and no threshold.

import { touchesProtectedPath } from "./boundary";
import type { FactoryConfig } from "./config";
import type { PrFacts } from "./pr-facts";
import type { MergeReadiness } from "./ports/scm";
import type { FactoryState } from "./state";

type Store = Pick<FactoryState, "getSetting" | "setSetting">;
export type Verdict = "approve" | "reject";

export interface EvidenceEntry {
  readonly pr: number;
  readonly agent: Verdict;
  readonly human: Verdict;
  // The protectedPaths globs this PR touched.
  readonly protectedHits: readonly string[];
}

export const EVIDENCE_KEEP = 200;
// Below this many human-reviewed PRs the agreement rate is anecdote, not evidence.
export const THIN_EVIDENCE = 10;
const key = (repo: string) => `merge-evidence:${repo}`;

export function evidenceEntries(state: Store, repo: string): EvidenceEntry[] {
  return JSON.parse(state.getSetting(key(repo)) || "[]") as EvidenceEntry[];
}

// The agent side: every reviewer passed and none holds a blocker. Undefined when no review ran.
export function agentVerdict(review: PrFacts["review"]): Verdict | undefined {
  if (!review || review.reviewers.length === 0) return undefined;
  return review.reviewers.every((r) => r.blockers === 0 && (r.verdict === undefined || r.verdict === "pass"))
    ? "approve"
    : "reject";
}

// The human side: only a decision counts; REVIEW_REQUIRED and no review say nothing.
export function humanVerdict(decision: MergeReadiness["reviewDecision"]): Verdict | undefined {
  return decision === "APPROVED" ? "approve" : decision === "CHANGES_REQUESTED" ? "reject" : undefined;
}

// One entry per PR: a later tick replaces the earlier one, so a re-read never double counts.
export function recordEvidence(
  state: Store,
  config: Pick<FactoryConfig, "repo" | "protectedPaths">,
  input: {
    pr: number;
    review: PrFacts["review"];
    decision: MergeReadiness["reviewDecision"];
    paths: readonly string[];
  },
): void {
  const agent = agentVerdict(input.review);
  const human = humanVerdict(input.decision);
  if (!agent || !human) return;
  const protectedHits = config.protectedPaths.filter((g) => touchesProtectedPath(input.paths, [g]).length > 0);
  const kept = evidenceEntries(state, config.repo).filter((e) => e.pr !== input.pr);
  state.setSetting(
    key(config.repo),
    JSON.stringify([...kept, { pr: input.pr, agent, human, protectedHits }].slice(-EVIDENCE_KEEP)),
  );
}

const rate = (es: readonly EvidenceEntry[]) => `${es.filter((e) => e.agent === e.human).length}/${es.length} agree`;

// The gates a repo has not set up, read off its config.
export function missingGates(config: Pick<FactoryConfig, "protectedPaths" | "merge">): string[] {
  const out: string[] = [];
  if (config.protectedPaths.length === 0) out.push("protectedPaths is empty");
  if (!config.merge.smokeUrl) out.push("merge.smokeUrl is not set, so no post-merge watch");
  if (!config.merge.previewUrl) out.push("merge.previewUrl is not set, so no UI preview");
  return out;
}

export function evidenceReport(state: Store, config: FactoryConfig): string {
  const es = evidenceEntries(state, config.repo);
  const lines = [`${config.repo}: agent versus human review, ${rate(es)}`];
  for (const glob of config.protectedPaths) {
    const hit = es.filter((e) => e.protectedHits.includes(glob));
    lines.push(`  ${glob}: ${hit.length ? rate(hit) : "no reviewed PRs"}`);
  }
  const gaps = missingGates(config);
  if (es.length < THIN_EVIDENCE) gaps.push(`thin review evidence: ${es.length} of ${THIN_EVIDENCE} human-reviewed PRs`);
  for (const glob of config.protectedPaths) {
    const n = es.filter((e) => e.protectedHits.includes(glob)).length;
    if (n < THIN_EVIDENCE) gaps.push(`thin review evidence on ${glob}: ${n} of ${THIN_EVIDENCE}`);
  }
  lines.push(gaps.length ? "Readiness gaps:" : "Readiness gaps: none", ...gaps.map((g) => `  - ${g}`));
  return lines.join("\n");
}
