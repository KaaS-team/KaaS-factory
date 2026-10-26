// A factory event, as the one progress note every outside surface shows: Linear activities, Slack
// thread replies, AG-UI events and MCP notifications all read this, so each says the same thing.
// The text is for the people on the issue: no host, model or token figure is in it.

import type { CloudEvent } from "../core/event";

export type ProgressKind = "action" | "thought" | "elicitation" | "response" | "error" | "link";

export interface Progress {
  readonly repo: string;
  readonly issue: number;
  readonly kind: ProgressKind;
  readonly text: string;
  readonly step?: string;
  readonly url?: string;
  // True when this note ends the run, so a surface can close its session or check.
  readonly done: boolean;
}

interface Data {
  repo?: string;
  issue?: number;
  step?: string;
  outcome?: string;
  result?: string;
  error?: string;
  url?: string;
}

const PARKED_ASK: Readonly<Record<string, string>> = {
  "awaiting-approval": "The plan is ready. Reply approve, or say what to change.",
  "needs-info": "There is a question for you on the issue. Reply with the answer.",
};

export function progressOf(e: CloudEvent): Progress | undefined {
  const d = (e.data ?? {}) as Data;
  if (typeof d.repo !== "string" || typeof d.issue !== "number") return undefined;
  const base = { repo: d.repo, issue: d.issue, ...(d.step ? { step: d.step } : {}), done: false };
  switch (e.type) {
    case "factory.step.started":
      return { ...base, kind: "action", text: `Running ${d.step}` };
    case "factory.step.completed":
      return { ...base, kind: "thought", text: `Finished ${d.step}` };
    case "factory.step.failed":
      return { ...base, kind: "error", text: `${d.step} failed`, done: true };
    case "factory.issue.parked":
      return {
        ...base,
        kind: "elicitation",
        text: PARKED_ASK[d.outcome ?? ""] ?? "Waiting for a person on the issue.",
      };
    case "factory.pr.opened":
      return d.url ? { ...base, kind: "link", text: "Pull request opened", url: d.url } : undefined;
    case "factory.run.completed":
      return { ...base, kind: "response", text: `Run ended: ${d.outcome}`, done: true };
    default:
      return undefined;
  }
}
