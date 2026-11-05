// The write routes: approve, steer and retry post the same /factory command `factory inbox <n> <action>` posts,
// through the same `act`, so a state that does not allow the action is refused before anything is written.

import { act, buildInbox, type InboxAction, InboxError } from "../inbox";
import type { TrackerPort } from "../ports/scm";
import type { Run } from "../state";

export type WriteTracker = Pick<TrackerPort, "getIssue" | "commentIssue">;

// steer is the CLI's `revise`: free text that changes what the runner does next.
const ACTION: Readonly<Record<string, InboxAction>> = {
  "runs.approve": "approve",
  "runs.steer": "revise",
  "runs.retry": "retry",
};

export interface WriteResult {
  status: number;
  body: { issue: number; posted: string } | { error: string };
}

export async function applyWrite(routeId: string, tracker: WriteTracker, run: Run, req: Request): Promise<WriteResult> {
  const action = ACTION[routeId]!;
  let text = "";
  if (action === "revise") {
    const given = (await req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof given?.text !== "string" || !given.text.trim())
      return { status: 400, body: { error: "text is required" } };
    text = given.text;
  }
  try {
    // The tracker is read here, not trusted from the run row: the labels on the issue are what the CLI acts on.
    const item = buildInbox([await tracker.getIssue(run.repo, run.issue)])[0];
    if (!item) return { status: 409, body: { error: `#${run.issue} is not waiting for anyone` } };
    return { status: 200, body: { issue: item.issue, posted: await act(tracker, run.repo, item, action, text) } };
  } catch (e) {
    if (e instanceof InboxError) return { status: 409, body: { error: e.message } };
    throw e;
  }
}
