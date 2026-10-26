// The tickets stage: a second agent splits a checked spec into tickets that block each other, and
// the factory files them as issues with the "Blocked by: #N" line src/blockers.ts already gates on.
// The agent drafts the graph; ticketProblems below decides whether it is a DAG that covers the spec.

import { blockerNumbers } from "../blockers";
import { minionOutput } from "../engine/minion";
import type { ScmPort } from "../ports/scm";
import { criteria, type Spec, type StageAgent, type StageOutcome } from "./spec";

export interface Ticket {
  // The agent's own handle for the ticket, so blockedBy can name one before it has an issue number.
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly acs: readonly string[];
  readonly blockedBy: readonly string[];
}

// The keys of a cycle, if the blocking edges have one; a ticket blocked by itself is a cycle of one.
export function findCycle(tickets: readonly Ticket[]): string[] | undefined {
  const by = new Map(tickets.map((t) => [t.key, t]));
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (key: string): string[] | undefined => {
    if (state.get(key) === "done") return undefined;
    if (state.get(key) === "open") return [...path.slice(path.indexOf(key)), key];
    state.set(key, "open");
    path.push(key);
    for (const next of by.get(key)?.blockedBy ?? []) {
      const cycle = by.has(next) ? visit(next) : undefined;
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const t of tickets) {
    const cycle = visit(t.key);
    if (cycle) return cycle;
  }
  return undefined;
}

// Every way a ticket list fails the spec: a duplicate, a ticket that delivers no criterion, a
// criterion no ticket delivers, an edge to nowhere, or a cycle that would block the work forever.
export function ticketProblems(spec: Spec, tickets: readonly Ticket[]): string[] {
  const problems: string[] = [];
  const acs = new Set(criteria(spec.markdown).map((a) => a.id));
  if (tickets.length === 0) problems.push("there are no tickets");
  const keys = new Set<string>();
  const titles = new Set<string>();
  for (const t of tickets) {
    if (keys.has(t.key)) problems.push(`ticket ${t.key} is listed twice`);
    const title = t.title.trim().toLowerCase();
    if (titles.has(title)) problems.push(`ticket ${t.key} duplicates the title "${t.title}"`);
    keys.add(t.key);
    titles.add(title);
    if (t.acs.length === 0) problems.push(`ticket ${t.key} covers no acceptance criterion`);
    for (const ac of t.acs)
      if (!acs.has(ac)) problems.push(`ticket ${t.key} names ${ac}, which the spec does not have`);
  }
  for (const t of tickets)
    for (const b of t.blockedBy)
      if (!keys.has(b)) problems.push(`ticket ${t.key} is blocked by ${b}, which is no ticket`);
  const covered = new Set(tickets.flatMap((t) => t.acs));
  for (const ac of acs) if (!covered.has(ac)) problems.push(`${ac} is covered by no ticket`);
  const cycle = findCycle(tickets);
  if (cycle) problems.push(`the blocking edges have a cycle: ${cycle.join(" -> ")}`);
  return problems;
}

// Blockers first, so each ticket's "Blocked by" line can name real issue numbers. Assumes no cycle.
export function fileOrder(tickets: readonly Ticket[]): Ticket[] {
  const by = new Map(tickets.map((t) => [t.key, t]));
  const out: Ticket[] = [];
  const placed = new Set<string>();
  const place = (t: Ticket) => {
    if (placed.has(t.key)) return;
    placed.add(t.key);
    for (const b of t.blockedBy) place(by.get(b)!);
    out.push(t);
  };
  for (const t of tickets) place(t);
  return out;
}

export function ticketBody(spec: Spec, t: Ticket, blockers: readonly number[]): string {
  const blocked = blockers.length ? blockers.map((n) => `#${n}`).join(", ") : "none";
  return [
    t.body.trim(),
    "",
    `Acceptance: specs/${spec.slug}.md ${t.acs.join(", ")}`,
    `Holdouts: ${t.acs.map((ac) => `holdout/${spec.slug}/${ac}.*`).join(", ")}`,
    `Blocked by: ${blocked}`,
  ].join("\n");
}

export interface FiledTicket {
  readonly key: string;
  readonly number: number;
  readonly blockedBy: readonly number[];
}

// Refuses a list that fails ticketProblems before it files anything, so a bad graph leaves no issues behind.
export async function fileTickets(
  scm: Pick<ScmPort, "createIssue">,
  repo: string,
  spec: Spec,
  tickets: readonly Ticket[],
  labels: string[],
): Promise<FiledTicket[]> {
  const problems = ticketProblems(spec, tickets);
  if (problems.length) throw new Error(`tickets: ${problems.join("; ")}`);
  const numbers = new Map<string, number>();
  const filed: FiledTicket[] = [];
  for (const t of fileOrder(tickets)) {
    const blockers = t.blockedBy.map((b) => numbers.get(b)!);
    const body = ticketBody(spec, t, blockers);
    // The dependency gate reads only this line; a body it parses differently would build out of order.
    if (blockerNumbers(body).join() !== blockers.join()) throw new Error(`tickets: ${t.key}'s blockers do not parse`);
    const number = await scm.createIssue(repo, t.title, body, labels);
    numbers.set(t.key, number);
    filed.push({ key: t.key, number, blockedBy: blockers });
  }
  return filed;
}

export function ticketsPrompt(spec: Spec): string {
  return [
    "Split the spec below into tickets a coding agent can build one at a time.",
    'Answer with one JSON object and nothing else: {"tickets": [{"key": "t1", "title": "...", "body": "...",',
    '"acs": ["AC-1"], "blockedBy": []}]}. Every ticket delivers at least one criterion, every criterion is',
    "delivered by some ticket, and blockedBy names the keys of tickets that must land first, with no cycle.",
    "<spec>",
    spec.markdown.replace(/</g, "&lt;"),
    "</spec>",
  ].join("\n");
}

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;

export function readTickets(raw: unknown): Ticket[] | undefined {
  const list = (raw as { tickets?: unknown } | undefined)?.tickets;
  if (!Array.isArray(list)) return undefined;
  const out: Ticket[] = [];
  for (const item of list) {
    const { key, title, body, acs, blockedBy } = (item ?? {}) as Record<string, unknown>;
    const a = strings(acs);
    const b = strings(blockedBy ?? []);
    if (typeof key !== "string" || typeof title !== "string" || typeof body !== "string" || !a || !b) return undefined;
    out.push({ key, title, body, acs: a, blockedBy: b });
  }
  return out;
}

export async function runTicketsStage(stage: StageAgent, spec: Spec): Promise<StageOutcome<Ticket[]>> {
  const run = await stage.executor.runStage({
    stage: "plan",
    issue: 0,
    cwd: stage.cwd,
    agent: stage.agent,
    prompt: ticketsPrompt(spec),
    maxBudgetUsd: stage.maxBudgetUsd,
    timeoutMinutes: stage.timeoutMinutes,
  });
  if (run.exitCode !== 0) return { ok: false, problems: [`the tickets agent exited ${run.exitCode}`], run };
  const tickets = readTickets(minionOutput("", run.finalMessage));
  if (!tickets) return { ok: false, problems: ['the tickets agent did not answer {"tickets": [...]}'], run };
  const problems = ticketProblems(spec, tickets);
  return problems.length ? { ok: false, problems, run } : { ok: true, value: tickets, run };
}
