import { parseMeta } from "../core/schedule";
import { isPlannedBody, parsePlannedIssue } from "../engine/import-plan";
import type { PriorityRule } from "./config";

export interface PickIssue {
  number: number;
  labels: string[];
  body: string;
}

export interface Slots {
  provider: string;
  free: number;
}

function preface(body: string): string {
  const cut = body.search(/^## /m);
  return cut < 0 ? body : body.slice(0, cut);
}

function parseRank(body: string): number {
  const m = /^Rank:\s*(\d+)/im.exec(preface(body));
  return m ? Number(m[1]!) : Number.POSITIVE_INFINITY;
}

// priority:P0..P4 label -> 0..4; no matching label -> 5 (sorts last).
function labelKey(labels: readonly string[]): number {
  for (const raw of labels) {
    const m = /^priority:p([0-4])$/i.exec(raw.trim());
    if (m) return Number(m[1]!);
  }
  return 5;
}

// Rank: n in the preface -> n; absent -> Infinity (sorts last).
function rankKey(body: string): number {
  return parseRank(body);
}

// Planned risk low/medium/high -> 0/1/2; anything else -> 1 (sorts medium).
function riskKey(body: string): number {
  if (!isPlannedBody(body)) return 1;
  const risk = parsePlannedIssue(body).plan?.risk;
  if (risk === "low") return 0;
  if (risk === "high") return 2;
  return 1;
}

// size:S/M/L label or planned file count bucket; else 1.
function sizeKey(issue: PickIssue): number {
  for (const raw of issue.labels) {
    const m = /^size:([sml])$/i.exec(raw.trim());
    if (m) {
      const c = m[1]!.toLowerCase();
      if (c === "s") return 0;
      if (c === "l") return 2;
      return 1;
    }
  }
  if (isPlannedBody(issue.body)) {
    const n = parsePlannedIssue(issue.body).plan?.files.length ?? 0;
    if (n <= 3) return 0;
    if (n <= 10) return 1;
    return 2;
  }
  return 1;
}

function epicGroupKey(issue: PickIssue): string {
  const meta = parseMeta(issue.body);
  if (meta.epic) return `e:${meta.epic}`;
  if (meta.milestone) return `m:${meta.milestone}`;
  return `i:${issue.number}`;
}

function compareRule<T extends PickIssue>(a: T, b: T, rule: PriorityRule): number {
  switch (rule) {
    case "label":
      return labelKey(a.labels) - labelKey(b.labels);
    case "rank":
      return rankKey(a.body) - rankKey(b.body);
    case "risk":
      return riskKey(a.body) - riskKey(b.body);
    case "size":
      return sizeKey(a) - sizeKey(b);
    case "number":
      return a.number - b.number;
    case "epic":
      return 0;
  }
}

function compareByRules<T extends PickIssue>(a: T, b: T, rules: readonly PriorityRule[]): number {
  for (const rule of rules) {
    const c = compareRule(a, b, rule);
    if (c !== 0) return c;
  }
  return 0;
}

export function rankReady<T extends PickIssue>(ready: readonly T[], rules: readonly PriorityRule[]): T[] {
  const chain = [...rules];
  if (!chain.includes("number")) chain.push("number");
  const epicAt = chain.indexOf("epic");
  if (epicAt < 0) return [...ready].sort((a, b) => compareByRules(a, b, chain));

  const beforeEpic = chain.slice(0, epicAt);
  const afterEpic = chain.slice(epicAt + 1);
  const inner: PriorityRule[] = [...beforeEpic, "number"];
  const byMember = [...ready].sort((a, b) => compareByRules(a, b, inner));
  const groupOrder = new Map<string, number>();
  for (const issue of byMember) {
    const g = epicGroupKey(issue);
    if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  const tail: PriorityRule[] = afterEpic.includes("number") ? afterEpic : [...afterEpic, "number"];
  return [...ready].sort((a, b) => {
    const ga = groupOrder.get(epicGroupKey(a))!;
    const gb = groupOrder.get(epicGroupKey(b))!;
    if (ga !== gb) return ga - gb;
    return compareByRules(a, b, tail);
  });
}

function trimPath(p: string): string {
  return p.trim().replace(/^\.\//, "");
}

function normPath(p: string): string {
  return trimPath(p).replace(/\/+$/, "");
}

function pathsConflict(a: string, b: string): boolean {
  const na = normPath(a);
  const nb = normPath(b);
  if (na === nb) return true;
  if (trimPath(a).endsWith("/") && (nb === na || nb.startsWith(`${na}/`))) return true;
  if (trimPath(b).endsWith("/") && (na === nb || na.startsWith(`${nb}/`))) return true;
  return na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function filesOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) for (const y of b) if (pathsConflict(x, y)) return true;
  return false;
}

function overlapsHeld(files: readonly string[], held: readonly string[], assigned: readonly string[][]): boolean {
  if (files.length === 0) return false;
  if (held.length > 0 && filesOverlap(files, held)) return true;
  for (const taken of assigned) if (filesOverlap(files, taken)) return true;
  return false;
}

function freeForProvider(input: {
  max: Record<string, number>;
  active: Record<string, number>;
  localFree: number;
  provider: string;
}): number {
  if (input.provider === "local") return Math.max(0, input.localFree);
  return Math.max(0, (input.max[input.provider] ?? 0) - (input.active[input.provider] ?? 0));
}

function mayUseCloud(files: readonly string[]): boolean {
  return files.length > 0;
}

export function planRefill<T extends PickIssue>(input: {
  ranked: readonly T[];
  order: readonly string[];
  max: Record<string, number>;
  active: Record<string, number>;
  localFree: number;
  filesOf: (issue: T) => string[];
  held: readonly string[];
  spendBlocked: boolean;
}): { assign: { issue: T; provider: string }[]; waiting: T[] } {
  const assign: { issue: T; provider: string }[] = [];
  const waiting: T[] = [];
  const taken: string[][] = [];
  const free = new Map<string, number>();
  for (const p of input.order) free.set(p, freeForProvider({ ...input, provider: p }));

  for (const issue of input.ranked) {
    const files = input.filesOf(issue);
    if (overlapsHeld(files, input.held, taken)) {
      waiting.push(issue);
      continue;
    }
    let picked: string | undefined;
    for (const provider of input.order) {
      if (input.spendBlocked && provider !== "local") continue;
      if (provider !== "local" && !mayUseCloud(files)) continue;
      const slots = free.get(provider) ?? 0;
      if (slots <= 0) continue;
      picked = provider;
      free.set(provider, slots - 1);
      break;
    }
    if (picked === undefined) continue;
    assign.push({ issue, provider: picked });
    if (files.length > 0) taken.push([...files]);
  }
  return { assign, waiting };
}

export function groomNeed(input: {
  readyDepth: number;
  target: number;
  perTick: number;
  enabled: boolean;
  spendBlocked: boolean;
  queued: number;
}): number {
  if (!input.enabled || input.spendBlocked) return 0;
  const need = Math.max(0, input.target - input.readyDepth);
  return Math.min(input.perTick, input.queued, need);
}

export function rankOf<T extends { number: number }>(ranked: readonly T[]): (a: T, b: T) => number {
  const at = new Map(ranked.map((issue, index) => [issue.number, index]));
  return (a, b) => {
    const ia = at.get(a.number);
    const ib = at.get(b.number);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.number - b.number;
  };
}
