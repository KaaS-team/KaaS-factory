// A plan that flags a boundary change (a public API, a schema, a config format) needs a decision
// record under docs/decisions/ in the same diff. The charter-glob check (src/docs-check.ts) covers
// paths a repo lists; this one covers the planner's own flag, or a Files-to-touch list that names a
// decision-bearing path, so the pr step can refuse before it spends an agent.

export const DECISIONS_DIR = "docs/decisions/";

// Directories whose files are decisions or architecture. A plan that touches one is a boundary change
// even when the planner forgot the flag.
export const DECISION_PATHS: readonly string[] = [DECISIONS_DIR, "docs/adr/", "docs/adrs/", "docs/architecture/"];

const NOT_A_RECORD = /^(readme|index)\.md$/i;

// A record is a markdown file directly under docs/decisions/, named for its decision (0007-title.md or
// title.md), never the directory's README or index.
export function isDecisionRecord(path: string): boolean {
  if (!path.startsWith(DECISIONS_DIR) || !path.endsWith(".md")) return false;
  const name = path.slice(DECISIONS_DIR.length);
  return !name.includes("/") && !NOT_A_RECORD.test(name);
}

// True when the planner flagged a boundary change or Files-to-touch names a decision-bearing path.
export function planFlagsBoundary(plan: {
  readonly boundaryChange?: boolean;
  readonly files?: readonly string[];
}): boolean {
  if (plan.boundaryChange === true) return true;
  return (plan.files ?? []).some((f) => DECISION_PATHS.some((d) => f.startsWith(d)));
}

// The refusal text, or undefined when the plan flags no boundary change or the diff carries a record.
export function boundaryRecordMissing(
  plan: { readonly boundaryChange?: boolean; readonly files?: readonly string[] } | undefined,
  changed: readonly string[],
): string | undefined {
  if (!plan || !planFlagsBoundary(plan)) return undefined;
  if (changed.some(isDecisionRecord)) return undefined;
  return `boundary_record_missing: the plan flags a boundary change but the diff adds no ${DECISIONS_DIR}*.md decision record`;
}
