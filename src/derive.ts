// GitHub is the state: everything the runner needs to resume an issue after a
// crash, or on a different machine entirely, is recoverable from its labels
// and comment thread alone (audit finding #21; plan section "Core refactor:
// GitHub is the state"). SQLite (state.ts) is a telemetry cache, not this.
//
// Every comment the runner posts that carries a structured artifact (triage,
// plan, verdict, build-status) appends a trailing hidden marker:
//   <!-- factory:data {"stage":"plan","json":{...}} -->
// parseDataMarkers recovers those; deriveIssueState turns them, plus the
// issue's current labels, into "where is this issue and what happened".

import { isHumanComment, parseChatOps } from "./chatops";
import type { GhComment, GhIssue } from "./github";
import { LABEL } from "./labels";
import type { Workflow } from "./core/workflow";

export interface DataMarker {
  readonly stage: string;
  readonly json: unknown;
}

const DATA_MARKER_RE = /<!-- factory:data (\{.*?\}) -->/gs;

export function parseDataMarkers(comments: readonly GhComment[]): DataMarker[] {
  const out: DataMarker[] = [];
  for (const c of comments) {
    for (const m of c.body.matchAll(DATA_MARKER_RE)) {
      try {
        const parsed = JSON.parse(m[1]!) as Partial<DataMarker>;
        if (parsed && typeof parsed.stage === "string") out.push({ stage: parsed.stage, json: parsed.json });
      } catch {
        // A hand-typed comment that happens to contain this literal text is
        // not trusted as data — skip it rather than throw.
      }
    }
  }
  return out;
}

export function latestDataFor(markers: readonly DataMarker[], stage: string): unknown {
  for (let i = markers.length - 1; i >= 0; i -= 1) if (markers[i]!.stage === stage) return markers[i]!.json;
  return undefined;
}

export function countMarkers(markers: readonly DataMarker[], stage: string): number {
  return markers.filter((m) => m.stage === stage).length;
}

// The built-in pipeline's steps, for a caller that has no workflow to hand.
const STAGE_BY_LABEL: Record<string, string> = {
  [LABEL.triaging]: "triage",
  [LABEL.planning]: "plan",
  [LABEL.building]: "build",
  [LABEL.verifying]: "verify",
  [LABEL.inReview]: "pr",
};

export interface DerivedIssueState {
  // The stage a resumed run should start from — the stage whose in-flight
  // label is currently on the issue, or "triage" for a fresh factory:ready.
  // A workflow step id; the built-in pipeline's are triage, plan, build, verify and pr.
  readonly resumeStage: string;
  // How many rounds of needs-info questions and verify rejects this issue has
  // already been through, recovered from the thread so a restart doesn't
  // reset the caps in derive's callers (round-cap findings #20/#5).
  readonly questionRounds: number;
  readonly rejectRounds: number;
  // The runner's own status comment, if one already exists, so a resume edits
  // it in place instead of posting a duplicate (finding #21).
  readonly statusCommentId: number | undefined;
  readonly markers: DataMarker[];
}

function findMarkerComment(comments: readonly GhComment[], needle: string): GhComment | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) if (comments[i]!.body.includes(needle)) return comments[i];
  return undefined;
}

// A `/factory retry` from a trusted human gives the loop a fresh set of
// verify rejects, so only rejects posted after the latest one count.
function countRejectsSinceRetry(comments: readonly GhComment[]): number {
  let lastRetry = -1;
  comments.forEach((c, i) => {
    if (isHumanComment(c) && parseChatOps(c.body).type === "retry") lastRetry = i;
  });
  return parseDataMarkers(comments.slice(lastRetry + 1)).filter(
    (m) => m.stage === "verify" && (m.json as { result?: string } | undefined)?.result === "reject",
  ).length;
}

const STAGE_MARKER_NAMES = new Set(["triage", "plan", "build", "verify"]);

// With a workflow, its steps' labels and ids replace the built-in ones, so a
// custom step (a `check`, say) is resumed and retried like any other.
export function deriveIssueState(issue: GhIssue, workflow?: Pick<Workflow, "steps">): DerivedIssueState {
  const byLabel = workflow
    ? Object.fromEntries(Object.values(workflow.steps).map((s) => [s.label, s.id]))
    : STAGE_BY_LABEL;
  const markerNames = workflow ? new Set(Object.keys(workflow.steps)) : STAGE_MARKER_NAMES;
  const labelNames = issue.labels.map((l) => l.name);
  const markers = parseDataMarkers(issue.comments);
  const runningLabel = labelNames.find((n) => byLabel[n]);

  let resumeStage: string;
  if (runningLabel) {
    resumeStage = byLabel[runningLabel]!;
  } else {
    // Parked (needs-info / needs-human / failed): there's no in-flight
    // label to read the stage off, since it was already replaced by the
    // parked one. Fall back to whichever stage most recently posted a
    // data marker — that's the stage a `/factory retry` should re-enter.
    // A question marker names the stage that asked it, so a plan or build
    // that stopped to ask resumes there rather than at an earlier stage.
    // A takeover marker names the stage the operator stopped, so retry re-enters it.
    const stageOf = (m: DataMarker): string | undefined =>
      m.stage === "question" || m.stage === "takeover"
        ? (m.json as { stage?: string } | undefined)?.stage
        : markerNames.has(m.stage)
          ? m.stage
          : undefined;
    const last = [...markers].reverse().find((m) => stageOf(m));
    resumeStage = (last && stageOf(last)) ?? (workflow ? Object.keys(workflow.steps)[0]! : "triage");
  }

  const statusComment = findMarkerComment(issue.comments, "<!-- factory:status v1");
  const rejectRounds = countRejectsSinceRetry(issue.comments);

  return {
    resumeStage,
    questionRounds: countMarkers(markers, "question"),
    rejectRounds,
    statusCommentId: statusComment?.id,
    markers,
  };
}
