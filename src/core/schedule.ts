// A pure dependency scheduler: issues and the deps they declare become an explainable order, a ready
// set, an overlap-free batch and one why line per issue. No GitHub call, file read or clock here
// (tests/hexagon.test.ts keeps core free of IO), so the watcher can call it later.

export type Runner = "factory" | "operator";

export interface IssueMeta {
  deps: number[];
  epic?: string;
  milestone?: string;
  runner: Runner;
  declared: boolean;
  problems: string[];
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

const VISITING = "visiting";
const DONE = "done";

// Metadata lives in the preface, the text before the first `## ` heading, so an inline
// `Spec: x · Epic: #82` line or a `Deps:` line under `## Change` is never read as metadata.
export function parseMeta(body: string): IssueMeta {
  const heading = body.search(/^## /m);
  const preface = heading < 0 ? body : body.slice(0, heading);
  const meta: IssueMeta = { deps: [], runner: "factory", declared: false, problems: [] };
  for (const m of preface.matchAll(/^(Deps|Epic|Milestone|Runner):[ \t]*(.*)$/gm)) {
    meta.declared = true;
    const key = m[1]!;
    const value = m[2]!.trim();
    if (key === "Deps") {
      for (const token of value.split(/[\s,]+/).filter(Boolean)) {
        if (token === "none") continue;
        const ref = /^#(\d+)$/.exec(token);
        if (ref) meta.deps.push(Number(ref[1]));
        else meta.problems.push(`Deps: "${token}" is not #<issue>.`);
      }
    } else if (key === "Runner") {
      if (value === "factory" || value === "operator") meta.runner = value;
      else meta.problems.push(`Runner: "${value}" is not factory or operator.`);
    } else if (!value) {
      meta.problems.push(`${key}: is empty.`);
    } else if (key === "Epic") {
      meta.epic = value;
    } else {
      meta.milestone = value;
    }
  }
  meta.deps = [...new Set(meta.deps)];
  return meta;
}

// Depth-first order: dependencies come before dependents, and independent nodes keep input order.
// A back edge is a cycle, reported once and never recursed; a dep that is not a node is missing.
// Nodes on a cycle are left out of `order`.
export function topoOrder(nodes: readonly { id: string; deps: readonly string[] }[]): {
  order: string[];
  cycles: string[][];
  missing: { id: string; dep: string }[];
} {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, string>();
  const stack: string[] = [];
  const order: string[] = [];
  const cycles: string[][] = [];
  const missing: { id: string; dep: string }[] = [];
  const cycleFrom = (path: string[], dep: string) => [...path.slice(path.indexOf(dep)), dep];
  const visit = (id: string): void => {
    state.set(id, VISITING);
    stack.push(id);
    for (const dep of byId.get(id)!.deps) {
      if (!byId.has(dep)) missing.push({ id, dep });
      if (state.get(dep) === VISITING) cycles.push(cycleFrom(stack, dep));
      else if (byId.has(dep) && !state.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, DONE);
    order.push(id);
  };
  for (const n of nodes) {
    if (!state.has(n.id)) visit(n.id);
  }
  const looped = new Set(cycles.flat());
  return { order: order.filter((id) => !looped.has(id)), cycles, missing };
}

// Milestone and epic: natural compare (M2 before M10), and an issue with none sorts last.
const byText = (a: string | undefined, b: string | undefined) =>
  a === b ? 0 : a === undefined ? 1 : b === undefined ? -1 : a.localeCompare(b, "en", { numeric: true });

const refs = (ns: readonly number[]) => ns.map((n) => `#${n}`).join(", ");

export function schedule(input: ScheduleInput): Schedule {
  const { nodes, open, done, slots } = input;
  const byNum = new Map(nodes.map((n) => [n.number, n]));
  // Without `done`, a dep that is neither a node nor open has closed, and the watcher already proved that.
  const isDone = (dep: number) => (done ? done.has(dep) : !byNum.has(dep) && !open.has(dep));
  const topo = topoOrder(nodes.map((n) => ({ id: String(n.number), deps: n.deps.map(String) })));
  const num = (id: string) => Number(id);
  const cycles = topo.cycles.map((c) => c.map(num));
  const inOrder = new Set(topo.order.map(num));
  const missing = topo.missing
    .map((m) => ({ issue: num(m.id), dep: num(m.dep) }))
    .filter((m) => done !== undefined && !done.has(m.dep) && !open.has(m.dep));

  // Who lists n as a dep, among the acyclic part only.
  const children = new Map<number, number[]>();
  for (const n of inOrder) {
    for (const d of byNum.get(n)!.deps) {
      if (byNum.has(d)) children.set(d, [...(children.get(d) ?? []), n]);
    }
  }
  const depthMemo = new Map<number, number>();
  const depthOf = (n: number): number => {
    const hit = depthMemo.get(n);
    if (hit !== undefined) return hit;
    const d = 1 + Math.max(0, ...(children.get(n) ?? []).map(depthOf));
    depthMemo.set(n, d);
    return d;
  };
  const sorted = [...inOrder].sort((a, b) => {
    const x = byNum.get(a)!;
    const y = byNum.get(b)!;
    return depthOf(b) - depthOf(a) || byText(x.milestone, y.milestone) || byText(x.epic, y.epic) || a - b;
  });

  const hasOpenDep = (n: number) => byNum.get(n)!.deps.some((d) => byNum.has(d) && !isDone(d));
  // The deepest id; a tie goes to the lower number.
  const deepest = (ids: readonly number[]) => {
    let best: number | undefined;
    for (const n of ids) {
      if (best === undefined || depthOf(n) > depthOf(best) || (depthOf(n) === depthOf(best) && n < best)) best = n;
    }
    return best;
  };
  const criticalPath: number[] = [];
  let cur = deepest(sorted.filter((n) => !hasOpenDep(n)));
  while (cur !== undefined) {
    criticalPath.push(cur);
    cur = deepest(children.get(cur) ?? []);
  }

  const ready = sorted.filter(
    (n) => open.has(n) && byNum.get(n)!.runner === "factory" && byNum.get(n)!.deps.every(isDone),
  );
  const operator = sorted.filter((n) => open.has(n) && byNum.get(n)!.runner === "operator");

  const batch: number[] = [];
  const deferred: Schedule["deferred"] = [];
  const taken = new Map<string, number>();
  const waitingForSlot = new Set<number>();
  for (const n of ready) {
    const node = byNum.get(n)!;
    if (node.files.some((f) => taken.has(f))) {
      const shared = node.files.filter((f) => taken.has(f));
      const sharedWith = batch.find((p) => byNum.get(p)!.files.some((f) => shared.includes(f)))!;
      deferred.push({ issue: n, sharedWith, files: shared });
      continue;
    }
    if (batch.length >= slots) {
      waitingForSlot.add(n);
      continue;
    }
    batch.push(n);
    for (const f of node.files) taken.set(f, n);
  }

  const readySet = new Set(ready);
  const deferredBy = new Map(deferred.map((d) => [d.issue, d]));
  const missingBy = new Map<number, number[]>();
  for (const m of missing) missingBy.set(m.issue, [...(missingBy.get(m.issue) ?? []), m.dep]);

  const why: Record<number, string> = {};
  for (const n of sorted) {
    const node = byNum.get(n)!;
    const gone = missingBy.get(n) ?? [];
    const waitingOn = node.deps.filter((d) => !isDone(d) && !gone.includes(d));
    const kids = children.get(n) ?? [];
    if (node.runner === "operator") why[n] = `#${n} operator work: needs you`;
    else if (gone.length) why[n] = `#${n} depends on ${refs(gone)}, which is not an open or closed issue`;
    else if (!readySet.has(n)) why[n] = `#${n} waits on ${refs(waitingOn)}`;
    else if (deferredBy.has(n)) {
      const d = deferredBy.get(n)!;
      why[n] = `#${n} deferred: shares ${d.files.join(", ")} with #${d.sharedWith}`;
    } else if (waitingForSlot.has(n)) why[n] = `#${n} waits for a slot (${batch.length} in use)`;
    else {
      const details: string[] = [];
      if (criticalPath.includes(n)) details.push(`on the critical path of ${criticalPath.length}`);
      if (kids.length) details.push(`unblocks ${refs(kids)}`);
      if (node.milestone) details.push(`milestone ${node.milestone}`);
      why[n] = details.length ? `#${n} ready: ${details.join(", ")}` : `#${n} ready`;
    }
  }
  for (const c of cycles) {
    const path = c.map((x) => `#${x}`).join(" -> ");
    for (const m of c.slice(0, -1)) why[m] = `#${m} on a cycle: ${path}`;
  }

  return { order: sorted, ready, batch, deferred, criticalPath, cycles, missing, operator, why };
}

// Sorts issues by number, then puts the declared ones back into the plan's order. Undeclared issues
// never move, so a repo with no metadata keeps its numeric order.
export function orderIssues<T extends { number: number }>(
  items: readonly T[],
  plan: Schedule,
  declared: (item: T) => boolean,
): T[] {
  const sorted = [...items].sort((a, b) => a.number - b.number);
  const rank = new Map(plan.order.map((n, i) => [n, i]));
  const positions: number[] = [];
  const pool: T[] = [];
  sorted.forEach((item, i) => {
    if (declared(item) && rank.has(item.number)) {
      positions.push(i);
      pool.push(item);
    }
  });
  pool.sort((a, b) => rank.get(a.number)! - rank.get(b.number)!);
  const out = [...sorted];
  positions.forEach((pos, k) => {
    out[pos] = pool[k]!;
  });
  return out;
}
