// What became of each review finding: fixed by a later diff, dismissed with a reason, or still open.
// The id ignores line numbers, so a finding that moves down the file in a later round keeps its id.
import { createHash } from "node:crypto";
import type { Finding } from "./artifacts";
import { measureActed } from "./review-acted";
import { parseWhere } from "./recheck";

export type Disposition = "fixed" | "dismissed" | "open";

export interface DispositionRow {
  id: string;
  what: string;
  disposition: Disposition;
}

export interface Dismissal {
  id: string;
  reason: string;
}

export interface Tally {
  found: number;
  fixed: number;
  dismissed: number;
  open: number;
}

// The file path of a `where`, without its line numbers; an unparseable `where` is used as written.
function pathOf(where: string | undefined): string {
  return parseWhere(where)?.path ?? where?.trim() ?? "";
}

export function stableId(f: string | Finding): string {
  const what = (typeof f === "string" ? f : f.what).trim().toLowerCase();
  let text = what;
  if (typeof f !== "string") {
    const place = pathOf(f.where);
    text = `${what}\n${place}`;
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function dispositions(
  findings: readonly (string | Finding)[],
  finalDiff: string,
  dismissals: readonly Dismissal[],
): DispositionRow[] {
  const acted = measureActed(findings, finalDiff).findings;
  return findings.map((f, i): DispositionRow => {
    const id = stableId(f);
    const row = acted[i];
    const d = dismissals.find((x) => x.id === id);
    const disposition = decide(row?.acted === true && row.anchored, d);
    return { id, what: typeof f === "string" ? f : f.what, disposition };
  });
}

function decide(fixed: boolean, d: Dismissal | undefined): Disposition {
  if (fixed) return "fixed";
  if (d && d.reason.trim() !== "") return "dismissed";
  return "open";
}

export function tally(rows: readonly DispositionRow[]): Tally {
  const count = (d: Disposition) => rows.filter((r) => r.disposition === d).length;
  return { found: rows.length, fixed: count("fixed"), dismissed: count("dismissed"), open: count("open") };
}
