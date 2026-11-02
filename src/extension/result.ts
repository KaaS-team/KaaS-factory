// The one document every extension transport ends in. A result is data, never instructions: it is
// checked against the invocation and head the runner asked about, and free text is cleaned.

import { stripOperatorDetail } from "../comment-voice";
import { cleanText } from "../sanitize-issue";

export const RESULT_STATUSES = ["pass", "fail", "neutral", "error", "timeout"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

const LEVELS = ["error", "warning", "note"] as const;
type Level = (typeof LEVELS)[number];

export type ExtensionFinding = { id: string; level: Level; message: string; fix?: string };

export type ExtensionResult = {
  invocation: string;
  head: string;
  status: ResultStatus;
  summary: string;
  findings: ExtensionFinding[];
  dropped: number;
  metrics: { costUsd?: number };
};

// What a customer sees: no operator block, no metrics.
export type CustomerResult = Pick<ExtensionResult, "status" | "summary" | "findings">;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clean = (s: string): string => stripOperatorDetail(cleanText(s));

export function parseExtensionResult(
  raw: unknown,
  want: { invocation: string; head: string },
): { ok: true; result: ExtensionResult; customer: CustomerResult } | { ok: false; reason: string } {
  if (!isObject(raw)) return { ok: false, reason: "result is not an object" };
  const o = raw;
  if (o.invocation !== want.invocation) return { ok: false, reason: "result is for another invocation" };
  if (o.head !== want.head) return { ok: false, reason: "result is for another sha" };
  if (typeof o.status !== "string" || !(RESULT_STATUSES as readonly string[]).includes(o.status))
    return { ok: false, reason: `field status must be one of ${RESULT_STATUSES.join(", ")}` };
  const status = o.status as ResultStatus;
  const summary = typeof o.summary === "string" ? clean(o.summary) : "";
  const findings: ExtensionFinding[] = [];
  let dropped = 0;
  for (const f of Array.isArray(o.findings) ? o.findings : []) {
    if (
      !isObject(f) ||
      typeof f.id !== "string" ||
      f.id === "" ||
      typeof f.message !== "string" ||
      f.message === "" ||
      !(LEVELS as readonly unknown[]).includes(f.level)
    ) {
      dropped++;
      continue;
    }
    const finding: ExtensionFinding = { id: f.id, level: f.level as Level, message: clean(f.message) };
    if (typeof f.fix === "string") finding.fix = clean(f.fix);
    findings.push(finding);
  }
  const m = isObject(o.metrics) ? o.metrics : {};
  const metrics: { costUsd?: number } = {};
  if (typeof m.costUsd === "number" && Number.isFinite(m.costUsd)) metrics.costUsd = m.costUsd;
  const result: ExtensionResult = {
    invocation: want.invocation,
    head: want.head,
    status,
    summary,
    findings,
    dropped,
    metrics,
  };
  return {
    ok: true,
    result,
    customer: { status, summary, findings },
  };
}
