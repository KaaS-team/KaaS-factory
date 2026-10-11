// A workflow's `on: cron:` and `on: event:` triggers. Each poll walks every minute since the
// last one it checked (at most CRON_CATCHUP_MINUTES back, so a laptop waking
// from a week asleep files one issue, not a thousand) and files a
// factory:ready issue for each trigger that matched. A trigger whose last
// issue is still open does not file another: the backlog never piles up.

import { cronMatches } from "../core/cron";
import type { CronTrigger, Workflow } from "../core/workflow";
import type { ScmPort } from "../ports/scm";
import { LABEL } from "../labels";
import { isExternalEventType, type CloudEvent } from "../core/event";

export const CRON_CATCHUP_MINUTES = 60;
const MINUTE = 60_000;

export interface CronStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

// The hidden line that ties a filed issue to the trigger that filed it.
export function cronMarker(workflow: string, index: number): string {
  return `<!-- factory:cron ${workflow}/${index} -->`;
}

export function matchedSince(t: Pick<CronTrigger, "cron" | "tz">, from: number, to: number): boolean {
  for (let m = from + MINUTE; m <= to; m += MINUTE) if (cronMatches(t.cron, new Date(m), t.tz)) return true;
  return false;
}

// The minutes (from, to] a poll checks for one schedule key, or undefined when
// this minute was already checked. Shared by workflow and minion schedules.
export function cronWindow(store: CronStore, key: string, now: Date): { from: number; to: number } | undefined {
  const to = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const last = Number(store.getSetting(key));
  // First boot checks only the current minute.
  const from = Number.isFinite(last) && last > 0 ? Math.max(last, to - CRON_CATCHUP_MINUTES * MINUTE) : to - MINUTE;
  return from >= to ? undefined : { from, to };
}

// Returns the numbers of the issues it filed.
export async function fireCron(github: ScmPort, store: CronStore, repo: string, workflow: Workflow, now: Date): Promise<number[]> {
  const triggers = workflow.triggers.cron;
  if (triggers.length === 0) return [];
  const key = `cron:last:${repo}:${workflow.name}`;
  const window = cronWindow(store, key, now);
  if (!window) return [];
  const { from, to } = window;

  const due = triggers.map((t, i) => [t, i] as const).filter(([t]) => matchedSince(t, from, to));
  const filed: number[] = [];
  if (due.length > 0) {
    const open = await github.listOpenIssues(repo);
    for (const [t, i] of due) {
      const marker = cronMarker(workflow.name, i);
      if (open.some((issue) => (issue.body ?? "").includes(marker))) continue;
      const body = `${t.body ? `${t.body}\n\n` : ""}Filed by the \`${workflow.name}\` workflow's schedule \`${t.cron.src}\` (${t.tz}).\n\n${marker}`;
      filed.push(await github.createIssue(repo, t.title, body, [LABEL.ready]));
    }
  }
  store.setSetting(key, String(to));
  return filed;
}

// `on: event:`. The hidden line ties the filed issue to the event, so a
// redelivered or replayed event whose issue is still open files nothing.
export function eventMarker(workflow: string, eventId: string): string {
  return `<!-- factory:event ${workflow}/${eventId.replace(/[^\w.:-]/g, "_")} -->`;
}

const EVENT_DATA_MAX = 4000;

// Files one issue when the event's type is one the workflow listens for.
// Returns its number, or undefined when nothing was filed. Only the factory's
// own events file it as factory:ready. Another app's event (POST /events, or a
// minion's agent-written answer) files it unlabelled: a valid HMAC proves who
// sent it, not that its data is fit to run, so a maintainer adds factory:ready
// and pickup checks who did, as for any issue (readyIsTrusted).
export async function fireEvent(github: ScmPort, repo: string, workflow: Workflow, event: CloudEvent): Promise<number | undefined> {
  if (!workflow.triggers.event.includes(event.type)) return undefined;
  const marker = eventMarker(workflow.name, event.id);
  const open = await github.listOpenIssues(repo);
  if (open.some((issue) => (issue.body ?? "").includes(marker))) return undefined;
  const data = JSON.stringify(event.data, null, 2) ?? "null";
  const shown = data.length > EVENT_DATA_MAX ? `${data.slice(0, EVENT_DATA_MAX)}\n... (truncated)` : data;
  const title = `${event.type}${event.subject ? `: ${event.subject}` : ""}`.slice(0, 200);
  const own = !isExternalEventType(event.type);
  const gate = own ? "" : `\n\nThis event came from outside the factory, so it does not start on its own. A maintainer who has read the data below adds \`${LABEL.ready}\` to run it.`;
  const body = `Filed by the \`${workflow.name}\` workflow on the \`${event.type}\` event from \`${event.source}\` (id \`${event.id}\`).${gate}\n\n\`\`\`json\n${shown}\n\`\`\`\n\n${marker}`;
  return await github.createIssue(repo, title, body, own ? [LABEL.ready] : []);
}
