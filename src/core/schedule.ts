// Turns a set of issues into an explainable order: what is ready, what is on the critical path,
// which picks can run side by side without touching the same file. Pure: no IO, no clock.

export type Runner = "factory" | "operator";

export interface IssueMeta {
  deps: number[];
  epic?: string;
  milestone?: string;
  runner: Runner;
  declared: boolean;
  problems: string[];
}

// Only the preface counts, so an inline `Spec: x · Epic: #82` line or a `Deps:` under a heading is
// not metadata.
export function parseMeta(body: string): IssueMeta {
  const cut = body.search(/^## /m);
  const preface = cut < 0 ? body : body.slice(0, cut);
  const meta: IssueMeta = { deps: [], runner: "factory", declared: false, problems: [] };
  for (const m of preface.matchAll(/^(Deps|Epic|Milestone|Runner):[ \t]*(.*)$/gm)) {
    const key = m[1]!;
    const value = m[2]!.trim();
    meta.declared = true;
    if (key === "Deps") {
      for (const token of value.split(/[\s,]+/).filter(Boolean)) {
        const n = /^#(\d+)$/.exec(token)?.[1];
        if (n) meta.deps.push(Number(n));
        else if (token !== "none") meta.problems.push(`Deps: "${token}" is not #<issue>.`);
      }
    } else if (key === "Runner") {
      if (value === "factory" || value === "operator") meta.runner = value;
      else if (value) meta.problems.push(`Runner: "${value}" is not factory or operator.`);
    } else if (!value) meta.problems.push(`${key}: is empty.`);
    else if (key === "Epic") meta.epic = value;
    else meta.milestone = value;
  }
  return meta;
}

const VISITING = 1;
const DONE = 2;

function cycleFrom(stack: readonly string[], dep: string): string[] {
  return [...stack.slice(stack.indexOf(dep)), dep];
}

export function topoOrder(nodes: readonly { id: string; deps: readonly string[] }[]): {
  order: string[];
  cycles: string[][];
  missing: { id: string; dep: string }[];
} {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, number>();
  const order: string[] = [];
  const cycles: string[][] = [];
  const missing: { id: string; dep: string }[] = [];
  const onCycle = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, VISITING);
    stack.push(id);
    for (const dep of byId.get(id)!.deps) {
      if (!byId.has(dep)) {
        missing.push({ id, dep });
        continue;
      }
      if (state.get(dep) === VISITING) cycles.push(cycleFrom(stack, dep));
      else if (!state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, DONE);
    order.push(id);
  };
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);
  for (const c of cycles) for (const id of c) onCycle.add(id);
  // A node that depends on a cycle can never run either.
  const blocked = (id: string, seen = new Set<string>()): boolean => {
    if (onCycle.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return byId.get(id)!.deps.some((d) => byId.has(d) && blocked(d, seen));
  };
  return { order: order.filter((id) => !blocked(id)), cycles, missing };
}

export interface SchedNode {
  number: number;
  deps: readonly number[];
  files: readonly string[];
  epic?: string;
  milestone?: string;
  runner: Runner;
}
export interface ScheduleInput {
  nodes: readonly SchedNode[];
  open: ReadonlySet<number>;
  done?: ReadonlySet<number>;
  slots: number;
}
export interface Schedule {
  order: number[];
  ready: number[];
  batch: number[];
  deferred: { issue: number; sharedWith: number; files: string[] }[];
  criticalPath: number[];
  cycles: number[][];
  missing: { issue: number; dep: number }[];
  operator: number[];
  why: Record<number, string>;
}

const natural = new Intl.Collator("en", { numeric: true }).compare;

export function schedule(input: ScheduleInput): Schedule {
  const { nodes, open, done, slots } = input;
  const byNum = new Map(nodes.map((n) => [n.number, n]));
  const graph = topoOrder(nodes.map((n) => ({ id: String(n.number), deps: n.deps.map(String) })));
  const inGraph = new Set(graph.order.map(Number));
  const cyclic = new Set(graph.cycles.flat().map(Number));
  // The watcher has already proved every dep of a ready issue closed, so a dep it does not know
  // about is done; with `done` given the caller is explicit and an unknown dep is missing.
  const isDone = (d: number): boolean => (done ? done.has(d) : !byNum.has(d) && !open.has(d));
  const openDeps = (n: SchedNode): number[] => n.deps.filter((d) => !isDone(d));
  const missing = graph.missing
    .map((m) => ({ issue: Number(m.id), dep: Number(m.dep) }))
    .filter((m) => done !== undefined || open.has(m.dep));
  const dependents = (num: number): SchedNode[] =>
    nodes.filter((n) => inGraph.has(n.number) && n.deps.includes(num) && !isDone(num));

  const depthOf = new Map<number, number>();
  const depth = (num: number): number => {
    const known = depthOf.get(num);
    if (known) return known;
    const d = 1 + Math.max(0, ...dependents(num).map((n) => depth(n.number)));
    depthOf.set(num, d);
    return d;
  };
  const live = nodes.filter((n) => inGraph.has(n.number));
  const rank = (a: SchedNode, b: SchedNode): number =>
    depth(b.number) - depth(a.number) ||
    (a.milestone === undefined ? 1 : 0) - (b.milestone === undefined ? 1 : 0) ||
    natural(a.milestone ?? "", b.milestone ?? "") ||
    natural(a.epic ?? "", b.epic ?? "") ||
    a.number - b.number;
  const ranked = [...live].sort(rank);
  const order = ranked.map((n) => n.number);

  const isReady = (n: SchedNode): boolean =>
    n.runner === "factory" && openDeps(n).length === 0 && !cyclic.has(n.number);
  const ready = ranked.filter(isReady).map((n) => n.number);
  const operator = nodes.filter((n) => n.runner === "operator").map((n) => n.number);

  const taken = new Map<string, number>();
  const batch: number[] = [];
  const deferred: Schedule["deferred"] = [];
  for (const num of ready) {
    if (batch.length >= slots) break;
    const node = byNum.get(num)!;
    const shared = node.files.filter((f) => taken.has(f));
    if (node.files.some((f) => taken.has(f))) {
      deferred.push({ issue: num, sharedWith: taken.get(shared[0]!)!, files: shared });
      continue;
    }
    for (const f of node.files) taken.set(f, num);
    batch.push(num);
  }

  const start = ranked.find((n) => openDeps(n).length === 0 && !cyclic.has(n.number));
  const criticalPath: number[] = [];
  for (let cur: SchedNode | undefined = start; cur; ) {
    criticalPath.push(cur.number);
    cur = [...dependents(cur.number)].sort((a, b) => depth(b.number) - depth(a.number) || a.number - b.number)[0];
  }

  const why: Record<number, string> = {};
  for (const n of nodes) {
    const num = n.number;
    const cyc = graph.cycles.find((c) => c.includes(String(num)));
    const gone = missing.find((m) => m.issue === num);
    if (cyc) why[num] = `#${num} on a cycle: ${cyc.map((c) => `#${c}`).join(" -> ")}`;
    else if (gone) why[num] = `#${num} depends on #${gone.dep}, which is not an open or closed issue`;
    else if (!inGraph.has(num)) why[num] = `#${num} waits on a cycle`;
    else if (n.runner === "operator") why[num] = `#${num} operator work: needs you`;
    else if (openDeps(n).length)
      why[num] = `#${num} waits on ${openDeps(n)
        .map((d) => `#${d}`)
        .join(", ")}`;
    else if (deferred.some((d) => d.issue === num)) {
      const d = deferred.find((x) => x.issue === num)!;
      why[num] = `#${num} deferred: shares ${d.files.join(", ")} with #${d.sharedWith}`;
    } else if (!batch.includes(num)) why[num] = `#${num} waits for a slot (${batch.length} in use)`;
    else {
      const after = dependents(num).map((d) => `#${d.number}`);
      const ms = n.milestone ? `, milestone ${n.milestone}` : "";
      why[num] =
        `#${num} ready: critical path ${depth(num)}${after.length ? ` (unblocks ${after.join(" then ")})` : ""}${ms}`;
    }
  }
  return {
    order,
    ready,
    batch,
    deferred,
    criticalPath,
    cycles: graph.cycles.map((c) => c.map(Number)),
    missing,
    operator,
    why,
  };
}

// Reorders only the declared items, among the places declared items already hold, so an issue
// without metadata never moves.
export function orderIssues<T extends { number: number }>(
  items: readonly T[],
  plan: Schedule,
  declared: (item: T) => boolean,
): T[] {
  const sorted = [...items].sort((a, b) => a.number - b.number);
  const rankOf = (n: number): number => {
    const i = plan.order.indexOf(n);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const movable = sorted.filter(declared);
  // Items absent from the order keep their numeric place among the declared.
  const placed = [...movable].sort((a, b) => rankOf(a.number) - rankOf(b.number) || a.number - b.number);
  const slotsAt = sorted.map((it, i) => (declared(it) ? i : -1)).filter((i) => i >= 0);
  const out = [...sorted];
  const absent = new Set(movable.filter((m) => !plan.order.includes(m.number)).map((m) => m.number));
  if (absent.size === 0) {
    slotsAt.forEach((at, k) => {
      out[at] = placed[k]!;
    });
    return out;
  }
  const inOrder = placed.filter((m) => !absent.has(m.number));
  const fillAt = slotsAt.filter((at) => !absent.has(sorted[at]!.number));
  fillAt.forEach((at, k) => {
    out[at] = inOrder[k]!;
  });
  return out;
}
