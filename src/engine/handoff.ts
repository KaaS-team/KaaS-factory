// A typed handoff between `uses: agent` steps. An agent hands the issue to another agent by name, with
// a reason; the hop is allowed only under a depth cap (a chain of hops) and a per-run cap (all hops).
// A refused hop is written to the run's ledger, never dropped. Asking a human is always allowed, so a
// capped team can still stop and ask. Pure decisions plus one small ledger file; no adapter.

import { mkdir } from "node:fs/promises";
import { runDir } from "../artifacts";

export const DEFAULT_DEPTH_CAP = 3;
export const DEFAULT_RUN_CAP = 6;

export type Handoff =
  | {
      readonly kind: "agent";
      readonly from: string;
      readonly to: string;
      readonly reason: string;
      readonly depth: number;
    }
  | { readonly kind: "human"; readonly from: string; readonly reason: string };

export interface HandoffCaps {
  readonly depth: number;
  readonly perRun: number;
}

export interface HandoffRecord {
  readonly handoff: Handoff;
  readonly allowed: boolean;
  // Why a hop was refused, in one plain sentence; absent when allowed.
  readonly refusal?: string;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Never throws: anything that is not a handoff comes back as a sentence.
export function parseHandoff(
  raw: unknown,
  depth: number,
): { ok: true; handoff: Handoff } | { ok: false; problem: string } {
  if (!isObj(raw)) return { ok: false, problem: "a handoff must be a mapping." };
  const { kind, from, to, reason } = raw;
  if (typeof from !== "string" || !NAME.test(from))
    return { ok: false, problem: "handoff.from must be an agent name." };
  if (typeof reason !== "string" || reason.trim() === "") return { ok: false, problem: "handoff.reason is required." };
  if (kind === "human") return { ok: true, handoff: { kind, from, reason } };
  if (kind !== "agent")
    return { ok: false, problem: `handoff.kind must be agent or human, got ${JSON.stringify(kind)}.` };
  if (typeof to !== "string" || !NAME.test(to)) return { ok: false, problem: "handoff.to must be an agent name." };
  return { ok: true, handoff: { kind, from, to, reason, depth } };
}

export function capsFrom(raw: unknown): HandoffCaps {
  const n = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d);
  const o = isObj(raw) ? raw : {};
  return { depth: n(o.depth, DEFAULT_DEPTH_CAP), perRun: n(o.per_run, DEFAULT_RUN_CAP) };
}

// `ledger` is every hop already decided in this run. Only allowed agent hops count toward the caps.
export function decideHandoff(handoff: Handoff, ledger: readonly HandoffRecord[], caps: HandoffCaps): HandoffRecord {
  if (handoff.kind === "human") return { handoff, allowed: true };
  const made = ledger.filter((r) => r.allowed && r.handoff.kind === "agent").length;
  if (handoff.depth >= caps.depth)
    return { handoff, allowed: false, refusal: `the chain is already ${handoff.depth} hops deep (cap ${caps.depth}).` };
  if (made >= caps.perRun)
    return { handoff, allowed: false, refusal: `this run already made ${made} handoffs (cap ${caps.perRun}).` };
  if (handoff.to === handoff.from) return { handoff, allowed: false, refusal: "an agent cannot hand off to itself." };
  return { handoff, allowed: true };
}

const ledgerPath = (cwd: string, issue: number) => `${cwd}/${runDir(issue)}/handoffs.json`;

export async function readLedger(cwd: string, issue: number): Promise<HandoffRecord[]> {
  const f = Bun.file(ledgerPath(cwd, issue));
  if (!(await f.exists())) return [];
  try {
    const rows = JSON.parse(await f.text());
    return Array.isArray(rows) ? (rows as HandoffRecord[]) : [];
  } catch {
    return [];
  }
}

// Decide one hop and write it down, refused or not. The caller follows `allowed`.
export async function recordHandoff(
  cwd: string,
  issue: number,
  raw: unknown,
  caps: HandoffCaps,
): Promise<HandoffRecord> {
  const ledger = await readLedger(cwd, issue);
  const parsed = parseHandoff(raw, ledger.filter((r) => r.allowed && r.handoff.kind === "agent").length);
  const fallback: Handoff = { kind: "human", from: "unknown", reason: "unreadable handoff" };
  const record: HandoffRecord = parsed.ok
    ? decideHandoff(parsed.handoff, ledger, caps)
    : { handoff: fallback, allowed: false, refusal: parsed.problem };
  await mkdir(`${cwd}/${runDir(issue)}`, { recursive: true });
  await Bun.write(ledgerPath(cwd, issue), `${JSON.stringify([...ledger, record], null, 2)}\n`);
  return record;
}
