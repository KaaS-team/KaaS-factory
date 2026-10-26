// One steering path for every surface: a Linear session, a Slack thread, an A2A call or any board's
// comment box. Each turns text into a Steer, and applySteer writes it to the tracker as the same
// signed comment or ready label the control plane posts, so a runner that only polls still obeys.

import { COMMANDS } from "../../dashboard/plane/commands";
import { atLeast, type Role } from "../../dashboard/plane/store";
import { signedBy } from "../chatops";
import { act, buildInbox, type InboxAction, InboxError } from "../inbox";
import { LABEL } from "../labels";
import type { TrackerPort } from "../ports/scm";

export type Steer =
  | { readonly kind: "start"; readonly title: string; readonly body: string }
  | { readonly kind: "ready"; readonly issue: number }
  | { readonly kind: "act"; readonly issue: number; readonly action: InboxAction; readonly text: string };

const VERBS: Readonly<Record<string, InboxAction>> = {
  approve: "approve",
  lgtm: "approve",
  revise: "revise",
  change: "revise",
  answer: "answer",
  retry: "retry",
  cancel: "cancel",
  stop: "cancel",
};

// `approve`, `/factory approve #12`, `revise use a map`: a verb, an optional issue, then its text.
// Free text in a thread bound to an issue is an answer; anywhere else it starts a task.
export function parseSteer(text: string, bound?: number): Steer | undefined {
  const words = text.trim().replace(/^\/factory\s+/i, "");
  if (!words) return undefined;
  const m = /^(\w+)\b[\s:]*(?:#(\d+)\b)?\s*([\s\S]*)$/.exec(words);
  const verb = m ? VERBS[m[1]!.toLowerCase()] : undefined;
  // A thread steers only the issue it is bound to, so a #N naming any other issue is dropped whole.
  if (verb && m?.[2] && Number(m[2]) !== bound) return undefined;
  if (verb && bound !== undefined) return { kind: "act", issue: bound, action: verb, text: m![3]!.trim() };
  if (bound !== undefined) return { kind: "act", issue: bound, action: "answer", text: words };
  const [title = "", ...rest] = words.replace(/^(start|build|task)\b[\s:]*/i, "").split("\n");
  return { kind: "start", title: title.trim().slice(0, 256), body: rest.join("\n").trim() };
}

export type SteerTracker = Pick<TrackerPort, "getIssue" | "commentIssue" | "createIssue" | "addLabels">;

// The issue it touched and what it wrote. An action the issue is not waiting for throws InboxError.
export async function applySteer(
  tracker: SteerTracker,
  repo: string,
  steer: Steer,
  by: string,
): Promise<{ issue: number; posted: string }> {
  if (steer.kind === "start") {
    const issue = await tracker.createIssue(repo, steer.title, signedBy(steer.body, by), [LABEL.ready]);
    return { issue, posted: LABEL.ready };
  }
  if (steer.kind === "ready") {
    await tracker.addLabels(repo, steer.issue, [LABEL.ready]);
    return { issue: steer.issue, posted: LABEL.ready };
  }
  const item = buildInbox([await tracker.getIssue(repo, steer.issue)])[0];
  if (!item) throw new InboxError(`#${steer.issue} is not waiting for anyone`);
  return { issue: steer.issue, posted: await act(tracker, repo, item, steer.action, steer.text, by) };
}

// The role a steer needs: the dashboard's own table, so a surface never grants what the web does not.
// Starting or readying a task is POST /api/tasks, an operator's route.
export function roleFor(steer: Steer): Role {
  if (steer.kind !== "act") return "operator";
  return Object.values(COMMANDS).find((c) => c.action === steer.action)?.role ?? "owner";
}

export interface SurfaceActor {
  readonly login: string;
  readonly role: Role | null;
}

// `U01ABC:ada, U02DEF:grace`: the outside ids allowed to steer, each mapped to a plane member's login.
export function surfaceActors(raw: string | undefined, roleOf: (login: string) => Role | null) {
  const ids = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const [id = "", login = ""] = pair.split(":").map((x) => x.trim());
    if (id && login) ids.set(id, login);
  }
  return (id: string | undefined): SurfaceActor | undefined => {
    const login = id === undefined ? undefined : ids.get(id);
    return login ? { login, role: roleOf(login) } : undefined;
  };
}

export const mayApply = (actor: SurfaceActor | undefined, steer: Steer): boolean =>
  !!actor?.role && atLeast(actor.role, roleFor(steer));

// A name from outside goes into a signed comment, whose signature line ends at the first < or newline.
export const cleanName = (name: string) =>
  name
    .replace(/[<>\s]+/g, " ")
    .trim()
    .slice(0, 80) || "someone";
