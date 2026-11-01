// Which review comments were acted on: a finding counts as acted when the next commit's diff
// changes a line inside the range its `where` names. String findings and findings with no
// `path:line` cannot be placed, so they are counted as not acted and kept out of the rate.
import type { Finding } from "./artifacts";
import { changedLines, parseWhere } from "./recheck";

export interface ActedFinding {
  what: string;
  where?: string;
  acted: boolean;
  anchored: boolean;
}

export interface ActedReport {
  findings: ActedFinding[];
  acted: number;
  anchored: number;
  // acted / anchored; undefined when no finding could be placed.
  rate: number | undefined;
}

export function measureActed(findings: readonly (string | Finding)[], nextDiff: string): ActedReport {
  const lines = changedLines(nextDiff);
  const rows = findings.map((f): ActedFinding => {
    if (typeof f === "string") return { what: f, acted: false, anchored: false };
    const at = parseWhere(f.where);
    if (!at) return { what: f.what, where: f.where, acted: false, anchored: false };
    const acted = lines.get(at.path)?.some(([a, b]) => at.from <= b && at.to >= a) === true;
    return { what: f.what, where: f.where, acted, anchored: true };
  });
  const anchored = rows.filter((r) => r.anchored).length;
  const acted = rows.filter((r) => r.acted).length;
  return { findings: rows, acted, anchored, rate: anchored === 0 ? undefined : acted / anchored };
}
