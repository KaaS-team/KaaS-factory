// The Line view's block for each stage. A run parked after a stage that ended
// ok (a refused triage, a plan awaiting approval) shows that block as done, and
// as waiting: the one place the Line asks for a person.
export const STAGES = ["triage", "plan", "build", "verify", "pr"];
export const WAITING = new Set(["needs-info", "awaiting-approval", "needs-human", "failed"]);
export const ACTIVE = new Set(["running", "verifying"]);

export function stationStates(run, stages) {
  const at = STAGES.indexOf(run.stage);
  return STAGES.map((name, i) => {
    const attempts = stages.filter((s) => s.stage === name);
    const last = attempts[attempts.length - 1];
    const live = i === at && ACTIVE.has(run.status);
    const stopped = i === at && !live && WAITING.has(run.status);
    const failed = !!last && !last.ok && (i < at || stopped);
    const done = i < at || run.status === "shipped" || (i === at && !!last && last.ok && !live);
    return { name, ms: attempts.reduce((n, s) => n + s.duration_ms, 0), live, failed, done, waiting: stopped && !failed };
  });
}
