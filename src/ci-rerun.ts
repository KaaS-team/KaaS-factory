// The follow-up step's `rerun_failed_ci_jobs` action: re-queue only the failed jobs of the run the
// follow-up is about, when no commit is needed. A pushed commit re-runs CI by itself, so a follow-up
// that pushed never reruns. Each rerun counts toward the per-run red-CI loop cap.

export const RERUN_ACTION = "rerun_failed_ci_jobs";
export const RED_LOOP_CAP = 2;

export const RERUN_PROMPT = `Use ${RERUN_ACTION} only when the red run needs no code change (a PR title check, a flaky job). A pushed commit re-runs CI by itself, so never call it after you push.`;

export interface FollowUpState {
  readonly runId: number; // the CI run this follow-up is about
  readonly pushed: boolean; // this follow-up pushed a commit
  readonly redLoops: number; // red-CI loops already spent on this run
}

export type RerunRefusal = "pushed-commit" | "wrong-run" | "loop-cap";

export type RerunResult =
  | { readonly ok: true; readonly state: FollowUpState }
  | { readonly ok: false; readonly reason: RerunRefusal; readonly state: FollowUpState };

// The port the runner supplies; it posts to the run's rerun-failed-jobs endpoint.
export interface RerunPort {
  rerunFailedJobs(runId: number): Promise<void>;
}

export function decideRerun(
  state: FollowUpState,
  requestedRunId: number,
  cap = RED_LOOP_CAP,
): RerunRefusal | undefined {
  if (state.pushed) return "pushed-commit";
  if (requestedRunId !== state.runId) return "wrong-run";
  if (state.redLoops >= cap) return "loop-cap";
  return undefined;
}

export async function rerunFailedCiJobs(
  state: FollowUpState,
  requestedRunId: number,
  port: RerunPort,
  cap = RED_LOOP_CAP,
): Promise<RerunResult> {
  const reason = decideRerun(state, requestedRunId, cap);
  if (reason) return { ok: false, reason, state };
  await port.rerunFailedJobs(state.runId);
  return { ok: true, state: { ...state, redLoops: state.redLoops + 1 } };
}
