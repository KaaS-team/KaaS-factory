// The finding-checker: after the reviewer, each must/should finding is read against the diff and
// tagged. Only a confirmed finding can reject verify; the other two are dropped with their tag.
//   confirmed    where names a changed line and evidence holds a reproduction
//   pre-existing where names a real location the diff did not change (the diff did not introduce it)
//   rejected     no usable where, or no reproduction

import type { Finding } from "./artifacts";
import { changedLines, parseWhere } from "./recheck";

export type FindingTag = "confirmed" | "rejected" | "pre-existing";

export function tagFinding(f: Finding, diff: string): FindingTag {
  const at = parseWhere(f.where);
  if (!at || !f.evidence?.trim()) return "rejected";
  const hunks = changedLines(diff).get(at.path);
  return hunks?.some(([a, b]) => at.from <= b && at.to >= a) ? "confirmed" : "pre-existing";
}

// One bullet per dropped finding, led by its tag.
export const describeTagged = (dropped: readonly Finding[], diff: string): string =>
  dropped.map((f) => `- [${tagFinding(f, diff)}] ${f.what}`).join("\n");
