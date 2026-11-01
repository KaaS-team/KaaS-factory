// Pinned table: what each GitHub check conclusion does to a run.

export type CheckStatus = "pass" | "neutral" | "fail" | "error" | "timeout";
export type CheckAction =
  | "continue"
  | "reject"
  | "park-awaiting-approval"
  | "retry-once"
  | "park-needs-human"
  | "record";

export const CONCLUSIONS: Record<string, [CheckStatus, CheckAction]> = {
  success: ["pass", "continue"],
  neutral: ["neutral", "continue"],
  failure: ["fail", "reject"],
  action_required: ["fail", "park-awaiting-approval"],
  timed_out: ["error", "retry-once"],
  cancelled: ["error", "retry-once"],
  stale: ["error", "retry-once"],
  skipped: ["timeout", "park-needs-human"],
};

export interface CheckOutcome {
  status: CheckStatus;
  action: CheckAction;
}

export function mapConclusion(conclusion: string | undefined, blocking: boolean): CheckOutcome {
  const row = conclusion !== undefined && Object.hasOwn(CONCLUSIONS, conclusion) ? CONCLUSIONS[conclusion] : undefined;
  const [status, action] = row ?? ["error", "retry-once"];
  return { status, action: blocking ? action : "record" };
}

export interface CheckRun {
  name: string;
  appSlug: string;
  headSha: string;
  status: string;
  conclusion?: string;
  completedAt?: string;
}

export function pickCheckRun(
  runs: CheckRun[],
  want: { name: string; app: string; head: string },
): CheckRun | undefined {
  const matching = runs
    .filter((r) => r.name === want.name && r.appSlug === want.app && r.headSha === want.head)
    .filter((r) => r.status === "completed");
  let best: CheckRun | undefined;
  for (const r of matching) {
    if (!best || Date.parse(r.completedAt ?? "") > Date.parse(best.completedAt ?? "")) best = r;
  }
  return best;
}

export function resolveCheck(
  runs: CheckRun[],
  want: { name: string; app: string; head: string },
  opts: { blocking: boolean; timedOut: boolean },
): CheckOutcome | undefined {
  const run = pickCheckRun(runs, want);
  if (!run) return opts.timedOut ? mapConclusion("skipped", opts.blocking) : undefined;
  return mapConclusion(run.conclusion, opts.blocking);
}
