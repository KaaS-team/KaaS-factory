// The PR facts document: every signal a full auto-merge stands on, in one object, so the merge
// decision reads one input and the receipt signs the same object the decision read. The numbers
// are the ten signals of the plan (kaas-factory-plan, "Full auto-merge signals").

import { type Autonomy, mergeAutoAllowed, STEERING } from "./autonomy";
import type { MergeDecision, MergeRefusal } from "./merge-policy";
import type { Statement } from "./receipt";
import type { RiskObject } from "./risk";

export interface PrFacts {
  // 1. fail-to-pass and pass-to-pass in a fresh checkout (src/clean-room.ts)
  readonly cleanRoom: { readonly ran: boolean; readonly failToPass: boolean; readonly passToPass: boolean } | null;
  // 2. mutants on changed lines, and the tamper check on the same diff
  readonly changedLines: { readonly mutants: number; readonly survived: readonly string[] } | null;
  readonly tamper: readonly string[];
  // 3, checks on the merged result, is the merge queue's (src/merge-queue.ts): it merges only a
  // head that is already on the latest base and green, so no fact here can claim it early.
  // 4. supply chain on the diff
  readonly supplyChain: {
    readonly highFindings: number;
    readonly newDependencies: readonly string[];
    readonly alerts: number;
  } | null;
  // 5 and 6: owners, protected paths, size and risk class
  readonly risk: RiskObject;
  // 7. reviewers on another model than the builder, with their unresolved blockers
  readonly review: {
    readonly builderModel: string;
    readonly reviewers: readonly { readonly model: string; readonly blockers: number; readonly verdict?: string }[];
  } | null;
  // 8. UI paths: preview, smoke and visual diffs nobody reviewed
  readonly ui: {
    readonly changed: boolean;
    readonly preview: boolean;
    readonly smoke: boolean;
    readonly unreviewedDiffs: number;
  };
  // 10. a post-merge watch is armed (src/post-merge.ts)
  readonly postMergeWatch: boolean;
}

const fail = (signal: number, detail: string): MergeRefusal => ({
  reason: "signal-failed",
  detail: `${signal}: ${detail}`,
});

// Each missing or red signal is one refusal; the caller still applies readiness and the file checks.
export function factRefusals(facts: PrFacts, mode: Autonomy): MergeRefusal[] {
  const out: MergeRefusal[] = [];
  const c = facts.cleanRoom;
  if (!c?.ran) out.push(fail(1, "the clean-room verify did not run"));
  else if (!c.failToPass || !c.passToPass) out.push(fail(1, "clean-room fail-to-pass or pass-to-pass is red"));
  if (!facts.changedLines) out.push(fail(2, "changed-line mutants did not run"));
  else if (facts.changedLines.survived.length)
    out.push(fail(2, `mutants survived: ${facts.changedLines.survived.join(", ")}`));
  if (facts.tamper.length) out.push(fail(2, `the diff weakens the proof: ${facts.tamper.join(", ")}`));
  const s = facts.supplyChain;
  if (!s) out.push(fail(4, "the supply-chain scan did not run"));
  else if (s.highFindings || s.alerts || s.newDependencies.length)
    out.push(
      fail(
        4,
        `${s.highFindings} high findings, ${s.alerts} alerts, new deps: ${s.newDependencies.join(", ") || "none"}`,
      ),
    );
  const r = facts.risk;
  if (r.blastRadius.owners.length) out.push(fail(5, `needs an owner: ${r.blastRadius.owners.join(", ")}`));
  if (r.blastRadius.protected.length) out.push(fail(5, `protected: ${r.blastRadius.protected.join(", ")}`));
  if (!mergeAutoAllowed(mode, r.level)) out.push(fail(6, `risk "${r.level}" is over what ${mode} merges`));
  out.push(...reviewRefusals(facts, mode));
  const ui = facts.ui;
  if (ui.changed && (!ui.preview || !ui.smoke)) out.push(fail(8, "a UI change has no preview or no smoke"));
  if (ui.changed && ui.unreviewedDiffs) out.push(fail(8, `${ui.unreviewedDiffs} visual diffs nobody reviewed`));
  if (!facts.postMergeWatch) out.push(fail(10, "no post-merge watch is armed"));
  return out;
}

// 7. The builder never reviews itself: a reviewer on the builder's model does not count.
function reviewRefusals(facts: PrFacts, mode: Autonomy): MergeRefusal[] {
  const review = facts.review;
  if (!review) return [fail(7, "no review ran")];
  const others = review.reviewers.filter((r) => r.model !== review.builderModel);
  const need = STEERING[mode].reviewers(facts.risk.level);
  const models = new Set(others.map((r) => r.model)).size;
  const out: MergeRefusal[] = [];
  if (models < need) out.push(fail(7, `${models} reviewers on another model, ${need} needed`));
  const red = others.filter((r) => r.verdict !== undefined && r.verdict !== "pass").length;
  if (red) out.push(fail(7, `${red} review sessions did not pass`));
  const blockers = others.reduce((n, r) => n + r.blockers, 0);
  if (blockers) out.push(fail(7, `${blockers} unresolved blockers`));
  return out;
}

// 9. What the receipt signs: the mode, the decision, every reason and the facts it read.
export interface MergeRecord {
  readonly autonomy: Autonomy;
  readonly outcome: MergeDecision["outcome"];
  readonly headSha: string;
  readonly reasons: readonly string[];
  readonly facts: PrFacts;
}

export function mergeRecord(decision: MergeDecision, facts: PrFacts, autonomy: Autonomy): MergeRecord {
  const reasons = decision.outcome === "merge" ? [] : decision.refusals.map((r) => `${r.reason}: ${r.detail}`);
  return { autonomy, outcome: decision.outcome, headSha: decision.headSha, reasons, facts };
}

// The record rides in the predicate the signature covers; kaas-verify refuses a "merge" that keeps
// refusal reasons or names another head (verify/src/main.rs check_merge).
export function withMerge(statement: Statement, merge: MergeRecord): Statement {
  return { ...statement, predicate: { ...statement.predicate, merge } as Statement["predicate"] };
}
