// Joins a plan with what the run did into one record a reader can compare. Pure: no I/O, no model.

import { RISKS } from "../team/schema";
import type { SummaryInput, SummaryRow, SummaryV1 } from "./types";

type Actual = SummaryInput["actual"];
type Plan = SummaryInput["plan"];

interface Built {
  row: SummaryRow;
  deviation?: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function criteriaRow(plan: Plan, a: Actual): Built {
  if (a.criteria.length === 0)
    return {
      row: {
        row: "criteria",
        planned: plural(plan.criteria.length, "criterion"),
        actual: null,
        status: "not-recorded",
      },
    };
  const unmet = a.criteria.filter((c) => !c.ok || a.notProven.includes(c.text));
  const met = a.criteria.length - unmet.length;
  const row: SummaryRow = {
    row: "criteria",
    planned: plural(plan.criteria.length, "criterion"),
    actual: `${met} met`,
    status: unmet.length > 0 ? "not-met" : a.rejectRounds > 0 ? "met-late" : "met",
  };
  if (unmet.length === 0) return { row };
  row.detail = unmet.map((c) => c.text).join("; ");
  return { row, deviation: `criteria: ${plural(unmet.length, "criterion")} not proven (${row.detail})` };
}

function filesRow(plan: Plan, a: Actual): Built {
  const planned = new Set(plan.files);
  const touched = a.touched;
  const extra = touched.filter((f) => !planned.has(f));
  const missing = plan.files.filter((f) => !touched.includes(f));
  const row: SummaryRow = {
    row: "files",
    planned: plural(plan.files.length, "file"),
    actual: plural(a.touched.length, "file"),
    status: extra.length + missing.length > 0 ? "deviation" : "met",
  };
  if (row.status === "met") return { row };
  const parts = [
    ...(extra.length > 0 ? [`not in plan: ${extra.join(", ")}`] : []),
    ...(missing.length > 0 ? [`planned, not touched: ${missing.join(", ")}`] : []),
  ];
  row.detail = parts.join("; ");
  return { row, deviation: `files: ${row.detail}` };
}

function riskRow(plan: Plan, a: Actual): Built {
  if (!a.riskAtHead) return { row: { row: "risk", planned: plan.risk, actual: null, status: "not-recorded" } };
  const over = RISKS.indexOf(a.riskAtHead) > RISKS.indexOf(plan.risk);
  const row: SummaryRow = { row: "risk", planned: plan.risk, actual: a.riskAtHead, status: over ? "deviation" : "met" };
  return over ? { row, deviation: `risk: planned ${plan.risk}, head is ${a.riskAtHead}` } : { row };
}

function scopeRow(plan: Plan, a: Actual): Built {
  const globs = plan.nonGoals.map((g) => new Bun.Glob(g));
  const hit = a.touched.filter((f) => globs.some((g) => g.match(f)));
  const row: SummaryRow = {
    row: "scope",
    planned: plural(plan.nonGoals.length, "non-goal"),
    actual: hit.length > 0 ? `touched: ${hit.join(", ")}` : "none touched",
    status: hit.length > 0 ? "deviation" : "met",
  };
  return hit.length > 0 ? { row, deviation: `scope: a non-goal path was touched (${hit.join(", ")})` } : { row };
}

function gatesRow(a: Actual): Built {
  const names = Object.keys(a.stages);
  if (!("verify" in a.stages))
    return { row: { row: "gates", planned: "verify ran", actual: null, status: "not-recorded" } };
  return { row: { row: "gates", planned: "verify ran", actual: `stages run: ${names.join(", ")}`, status: "met" } };
}

function reviewRow(a: Actual): SummaryRow {
  if (!a.review) return { row: "review", planned: "independent review", actual: null, status: "not-recorded" };
  const r = a.review;
  return {
    row: "review",
    planned: "independent review",
    actual: `${r.found} found, ${r.fixed} fixed, ${r.dismissed} dismissed, ${r.open} open`,
    status: r.open > 0 ? "deviation" : "met",
  };
}

function reviewBuilt(a: Actual): Built {
  const row = reviewRow(a);
  const open = a.review?.open ?? 0;
  return open > 0 ? { row, deviation: `review: ${plural(open, "finding")} still open` } : { row };
}

function qaRow(a: Actual): Built {
  if (!a.qa) return { row: { row: "qa", planned: "qa checks pass", actual: null, status: "not-recorded" } };
  const ok = a.qa.passed === a.qa.total;
  return {
    row: {
      row: "qa",
      planned: "qa checks pass",
      actual: `${a.qa.passed} of ${a.qa.total} passed`,
      status: ok ? "met" : "not-met",
    },
  };
}

function attemptsRow(a: Actual): Built {
  const reruns = Object.entries(a.stages).filter(([, n]) => n > 1);
  const notes = [
    ...reruns.map(([s, n]) => `${s} ran ${n} times`),
    ...(a.rejectRounds > 0 ? [plural(a.rejectRounds, "verify rejection")] : []),
    ...(a.retries > 0 ? [plural(a.retries, "retry")] : []),
    ...(a.takeover ? ["a human took over"] : []),
  ];
  if (notes.length === 0) return { row: { row: "attempts", planned: "one pass", actual: "one pass", status: "met" } };
  const detail = notes.join("; ");
  return {
    row: { row: "attempts", planned: "one pass", actual: detail, status: "deviation" },
    deviation: `attempts: ${detail}`,
  };
}

export function buildSummary(input: SummaryInput): SummaryV1 {
  const { plan, operator } = input;
  const a = input.actual;
  const built = [
    criteriaRow(plan, a),
    filesRow(plan, a),
    riskRow(plan, a),
    scopeRow(plan, a),
    gatesRow(a),
    reviewBuilt(a),
    qaRow(a),
    attemptsRow(a),
  ];
  const deviations = built.flatMap((b) => (b.deviation ? [b.deviation] : []));
  const metCount = a.criteria.filter((c) => c.ok && !a.notProven.includes(c.text)).length;
  const devText = deviations.length === 0 ? "no deviations" : plural(deviations.length, "deviation");
  const summary: SummaryV1 = {
    apiVersion: "factory.summary/v1",
    oneLine: `${metCount} of ${plan.criteria.length} criteria met, ${devText}`,
    outcome: plan.goal,
    planVsReality: built.map((b) => b.row),
    deviations,
    notProven: [...a.notProven],
  };
  if (operator) summary.operator = operator;
  return summary;
}
