// What started a run, and who decided an approval. An audit export must not read a timer as a person:
// a lapsed park window is stored as decision "timed", by "timer", never as an "approve" by a human.

export const RUN_ORIGINS = ["person", "watcher", "schedule", "handoff"] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export const HANDOFF_MARKER = "<!-- factory:handoff";
const CRON_MARKER = "<!-- factory:cron ";
const EVENT_MARKER = "<!-- factory:event ";

// Read from the hidden line the trigger or handoff left in the issue body; no marker means a person
// labeled the issue ready.
export function runOriginOf(body: string | null | undefined): RunOrigin {
  const text = body ?? "";
  if (text.includes(CRON_MARKER)) return "schedule";
  if (text.includes(HANDOFF_MARKER)) return "handoff";
  if (text.includes(EVENT_MARKER)) return "watcher";
  return "person";
}

export type ApprovalDecision = "approve" | "revise" | "timed";
export const TIMER = "timer";

// A timed decision is never made by a human, whatever name arrives with it.
export function decidedBy(decision: ApprovalDecision, by: string): string {
  return decision === "timed" ? TIMER : by;
}

// The journal resumes past a park on a person's approve or on a lapsed window.
export const approves = (decision: unknown): boolean => decision === "approve" || decision === "timed";

export interface AuditApproval {
  readonly token: string;
  readonly decision: string;
  readonly by: string;
  readonly human: boolean;
}

// One row per resolved approval for an audit export; human is false for a timed one.
export function approvalAudit(rows: readonly { type: string; data: string }[]): AuditApproval[] {
  const out: AuditApproval[] = [];
  for (const r of rows) {
    if (r.type !== "factory.approval.resolved") continue;
    let d: Record<string, unknown> = {};
    try {
      d = (JSON.parse(r.data) as Record<string, unknown>) ?? {};
    } catch {}
    out.push({
      token: String(d.token),
      decision: String(d.decision),
      by: String(d.by),
      human: d.decision !== "timed",
    });
  }
  return out;
}
