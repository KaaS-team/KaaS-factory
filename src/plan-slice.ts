// Slices a backlog into runnable units (#392). Items linked by deps form one epic with ordered tasks;
// an epic above the minute cap is cut between tasks, never inside one. Pure: nothing here reads a repo.

export interface BacklogItem {
  readonly id: string;
  readonly deps: readonly string[];
  readonly files: readonly string[];
  readonly minutes: number;
}

export interface SliceUnit {
  readonly id: string;
  readonly tasks: readonly string[];
  readonly files: readonly string[];
  readonly minutes: number;
  /** The unit that must merge first: the previous part of the same epic. */
  readonly after?: string;
}

export interface SliceReport {
  readonly longestChain: number;
  readonly warning?: string;
}

export const DEFAULT_CAP_MINUTES = 30;
export const CHAIN_WARN_ABOVE = 2;

// Dependencies first; ties keep input order. A dep id outside the backlog is already met and ignored.
function ordered(items: readonly BacklogItem[]): BacklogItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: BacklogItem[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (item: BacklogItem): void => {
    if (state.get(item.id) === "done") return;
    if (state.get(item.id) === "visiting") throw new Error(`dependency cycle at ${item.id}`);
    state.set(item.id, "visiting");
    for (const dep of item.deps) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    state.set(item.id, "done");
    out.push(item);
  };
  for (const item of items) visit(item);
  return out;
}

// Connected components of the dependency graph, each in dependency order.
function epics(items: readonly BacklogItem[]): BacklogItem[][] {
  const parent = new Map(items.map((i) => [i.id, i.id]));
  const root = (x: string): string => {
    const p = parent.get(x)!;
    return p === x ? x : root(p);
  };
  for (const item of items) for (const dep of item.deps) if (parent.has(dep)) parent.set(root(item.id), root(dep));
  const groups = new Map<string, BacklogItem[]>();
  for (const item of ordered(items)) {
    const key = root(item.id);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.values()];
}

export function sliceBacklog(items: readonly BacklogItem[], capMinutes = DEFAULT_CAP_MINUTES): SliceUnit[] {
  const units: SliceUnit[] = [];
  for (const epic of epics(items)) {
    const parts: BacklogItem[][] = [];
    let used = 0;
    for (const task of epic) {
      if (parts.length === 0 || used + task.minutes > capMinutes) {
        parts.push([]);
        used = 0;
      }
      parts[parts.length - 1]!.push(task);
      used += task.minutes;
    }
    parts.forEach((part, n) => {
      const base = epic[0]!.id;
      units.push({
        id: n === 0 ? base : `${base}#${n + 1}`,
        tasks: part.map((t) => t.id),
        files: [...new Set(part.flatMap((t) => t.files))],
        minutes: part.reduce((sum, t) => sum + t.minutes, 0),
        ...(n === 0 ? {} : { after: units[units.length - 1]!.id }),
      });
    });
  }
  return units;
}

export function chainReport(units: readonly SliceUnit[]): SliceReport {
  const depth = new Map<string, number>();
  let longest = 0;
  for (const u of units) {
    const d = (u.after ? (depth.get(u.after) ?? 0) : 0) + 1;
    depth.set(u.id, d);
    longest = Math.max(longest, d);
  }
  if (longest <= CHAIN_WARN_ABOVE) return { longestChain: longest };
  return { longestChain: longest, warning: `longest dependency chain is ${longest}, above ${CHAIN_WARN_ABOVE}` };
}
