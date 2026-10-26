// AG-UI: an agent front end (CopilotKit and others) follows a run as the protocol's event stream.
// An opt-in integration, never a default: the dashboard serves it only when FACTORY_AGUI is set.
// It reads the same outbox the watcher writes, so it shows exactly what every other surface shows.

import type { CloudEvent } from "../core/event";
import { progressOf } from "./progress";

export const AGUI_ENV = { on: "FACTORY_AGUI" } as const;

export type AguiEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string }
  | { type: "STEP_STARTED" | "STEP_FINISHED"; stepName: string }
  | { type: "RUN_FINISHED"; threadId: string; runId: string; result: string }
  | { type: "RUN_ERROR"; message: string }
  | { type: "CUSTOM"; name: string; value: unknown };

// One issue's events, in order. A run starts at its first step and ends at run.completed or a failure.
export function aguiEvents(events: readonly CloudEvent[], repo: string, issue: number): AguiEvent[] {
  const out: AguiEvent[] = [];
  const threadId = `${repo}#${issue}`;
  let runId: string | undefined;
  for (const e of events) {
    const p = progressOf(e);
    if (!p || p.repo !== repo || p.issue !== issue) continue;
    if (!runId && e.type === "factory.step.started") {
      runId = e.id;
      out.push({ type: "RUN_STARTED", threadId, runId });
    }
    if (e.type === "factory.step.started") out.push({ type: "STEP_STARTED", stepName: p.step ?? "" });
    else if (e.type === "factory.step.completed") out.push({ type: "STEP_FINISHED", stepName: p.step ?? "" });
    else if (p.kind === "error") out.push({ type: "RUN_ERROR", message: p.text });
    else if (p.kind === "elicitation") out.push({ type: "CUSTOM", name: "factory.needs_you", value: p.text });
    else if (p.kind === "link") out.push({ type: "CUSTOM", name: "factory.pull_request", value: p.url });
    if (p.done) {
      if (runId && p.kind !== "error") out.push({ type: "RUN_FINISHED", threadId, runId, result: p.text });
      runId = undefined;
    }
  }
  return out;
}

export const sse = (events: readonly AguiEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
