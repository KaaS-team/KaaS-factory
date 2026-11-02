// The customer view of a summary: a type with no operator field, and free text stripped of
// operator detail, so a stakeholder surface cannot carry what an operator surface may.

import { stripOperatorDetail } from "../comment-voice";
import type { SummaryRow, SummaryV1 } from "./types";

export type CustomerSummary = Pick<SummaryV1, "oneLine" | "outcome" | "deviations" | "notProven"> & {
  rows: SummaryRow[];
};

const clean = (text: string) => stripOperatorDetail(text);

function cleanRow(r: SummaryRow): SummaryRow {
  const row: SummaryRow = {
    row: r.row,
    planned: clean(r.planned),
    actual: r.actual === null ? null : clean(r.actual),
    status: r.status,
  };
  if (r.detail !== undefined) row.detail = clean(r.detail);
  return row;
}

export function customerView(s: SummaryV1): CustomerSummary {
  // biome-ignore format: the allowlist stays on one line so a mutation can anchor on it
  return { oneLine: clean(s.oneLine), outcome: s.outcome, rows: s.planVsReality.map(cleanRow), deviations: s.deviations.map(clean), notProven: s.notProven };
}

const cell = (text: string) => text.replace(/\|/g, "/").replace(/\n/g, " ");

export function renderStakeholder(v: CustomerSummary): string {
  const lines = [v.oneLine, "", "| Planned | Actual | Status |", "| --- | --- | --- |"];
  for (const r of v.rows) {
    const actual = r.status === "not-recorded" || r.actual === null ? "not recorded" : r.actual;
    lines.push(`| ${cell(r.planned)} | ${cell(actual)} | ${r.status === "not-recorded" ? "not recorded" : r.status} |`);
  }
  if (v.deviations.length > 0) {
    lines.push("", "Deviations", "", ...v.deviations.map((d) => `- ${d}`));
  }
  return `${lines.join("\n")}\n`;
}
