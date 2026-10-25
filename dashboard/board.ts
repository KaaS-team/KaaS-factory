// The board, built purely from GitHub labels — no SQLite required. This is
// what makes the dashboard work as a stateless cockpit onto a CI-driven
// repo (plan: "Run anywhere"), and what fixes the parked-items-show-as-Done
// bug (audit finding #22): a parked label (needs-info/needs-human/failed)
// always wins over a state label and routes to "attention", never "done".
// "done" isn't a column at all here — a shipped issue is closed, so it
// simply falls out of `gh issue list --state open`; the SQLite-backed
// /api/runs feed is what still shows recently-shipped rows locally.

import type { GhIssue } from "../src/github";
import { plain } from "../src/display";
import { LABEL, isParkedLabel, isStateLabel } from "../src/labels";

export type BoardColumn = "intake" | "triage" | "plan" | "build" | "verify" | "pr" | "attention";

export interface BoardCard {
  readonly issue: number;
  readonly title: string;
  readonly column: BoardColumn;
  readonly stateLabel: string | null;
  readonly parkedLabel: string | null;
  readonly typeLabels: readonly string[];
  // No factory:* label at all yet — a plain issue (hand-filed, or from
  // `factory scan`) that a human still needs to mark ready.
  readonly needsMarkReady: boolean;
}

const STATE_TO_COLUMN: Readonly<Record<string, BoardColumn>> = {
  [LABEL.ready]: "intake",
  [LABEL.blocked]: "intake",
  [LABEL.triaging]: "triage",
  [LABEL.planning]: "plan",
  [LABEL.awaitingApproval]: "plan",
  [LABEL.building]: "build",
  [LABEL.verifying]: "verify",
  [LABEL.inReview]: "pr",
};

// Parked beats state beats "no label yet" — an issue the loop parked stays
// visible as needing a human even if (by some path) it still carries a
// stale state label.
export function columnFor(labelNames: readonly string[]): BoardColumn {
  const parked = labelNames.find(isParkedLabel);
  if (parked) return "attention";
  const state = labelNames.find(isStateLabel);
  if (state) return STATE_TO_COLUMN[state] ?? "intake";
  return "intake";
}

export function buildBoard(issues: readonly GhIssue[]): BoardCard[] {
  return issues.map((issue) => {
    const names = issue.labels.map((l) => l.name);
    const stateLabel = names.find(isStateLabel) ?? null;
    const parkedLabel = names.find(isParkedLabel) ?? null;
    return {
      issue: issue.number,
      title: plain(issue.title),
      column: columnFor(names),
      stateLabel,
      parkedLabel,
      typeLabels: names.filter((n) => !isStateLabel(n) && !isParkedLabel(n) && n !== LABEL.monitor),
      needsMarkReady: stateLabel === null && parkedLabel === null,
    };
  });
}
