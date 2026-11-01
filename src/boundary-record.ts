// A plan that flags a boundary change (a public API, a schema, a config format) needs a decision
// record under docs/decisions/ in the same diff. The charter-glob check (src/docs-check.ts) covers
// paths a repo lists; this one covers the planner's own flag, so the pr step can refuse before it spends an agent.

export const DECISIONS_DIR = "docs/decisions/";

// The refusal text, or undefined when the plan flags no boundary change or the diff carries a record.
export function boundaryRecordMissing(
  plan: { readonly boundaryChange?: boolean } | undefined,
  changed: readonly string[],
): string | undefined {
  if (plan?.boundaryChange !== true) return undefined;
  if (changed.some((p) => p.startsWith(DECISIONS_DIR) && p.endsWith(".md"))) return undefined;
  return `boundary_record_missing: the plan flags a boundary change but the diff adds no ${DECISIONS_DIR}*.md file`;
}
