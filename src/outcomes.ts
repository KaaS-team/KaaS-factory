// What a workflow's work came to, read from repo state, and what each kept outcome cost.
// Spend alone rewards a workflow that does less; cost per accepted outcome does not.

export type OutcomeState = "merged" | "closed" | "kept" | "dismissed" | "acted" | "ignored";

export const ACCEPTED: readonly OutcomeState[] = ["merged", "kept", "acted"];
export const OUTCOME_STATES: readonly OutcomeState[] = ["merged", "closed", "kept", "dismissed", "acted", "ignored"];

export interface Outcome {
  kind: "pr" | "issue" | "comment";
  workflow: string;
  team: string;
  // When the repo settled it (merge, close or the thread's close); the window filters on this.
  at: string;
  state: OutcomeState;
  // null is an unknown cost; the work item's cost sits on one outcome only, the rest carry 0.
  cost_usd: number | null;
}

export interface Group {
  name: string;
  accepted: number;
  rejected: number;
  states: Partial<Record<OutcomeState, number>>;
  // Left out when any cost in the group is unknown, so a total is never understated.
  cost_usd?: number;
  unknownCost?: number;
  // Left out when nothing was accepted: dividing by zero would read as free.
  costPerAccepted?: number;
}

export interface VariantComparison {
  workflow: string;
  variants: Group[];
  // The variant with the lowest cost per accepted outcome; absent when none has one.
  cheapest?: string;
}

export interface OutcomeReport {
  window: { since?: string; until?: string };
  workflows: Group[];
  teams: Group[];
  variants: VariantComparison[];
}

// A variant is a workflow named `<base>__<variant>`; the report groups them under the base.
const VARIANT_SEP = "__";
export const variantOf = (workflow: string): { base: string; variant?: string } => {
  const i = workflow.indexOf(VARIANT_SEP);
  return i > 0 && i + VARIANT_SEP.length < workflow.length
    ? { base: workflow.slice(0, i), variant: workflow.slice(i + VARIANT_SEP.length) }
    : { base: workflow };
};

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

function group(name: string, items: readonly Outcome[]): Group {
  const states: Group["states"] = {};
  for (const o of items) states[o.state] = (states[o.state] ?? 0) + 1;
  const accepted = items.filter((o) => ACCEPTED.includes(o.state)).length;
  const unknown = items.filter((o) => o.cost_usd === null).length;
  const g: Group = { name, accepted, rejected: items.length - accepted, states };
  if (unknown) g.unknownCost = unknown;
  else {
    g.cost_usd = round(
      items.reduce((sum, o) => sum + (o.cost_usd ?? 0), 0),
      4,
    );
    if (accepted) g.costPerAccepted = round(g.cost_usd / accepted, 4);
  }
  return g;
}

function by(items: readonly Outcome[], key: (o: Outcome) => string): Group[] {
  const map = new Map<string, Outcome[]>();
  for (const o of items) map.set(key(o), [...(map.get(key(o)) ?? []), o]);
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, list]) => group(name, list));
}

export function outcomeReport(all: readonly Outcome[], window: { since?: string; until?: string } = {}): OutcomeReport {
  const lo = window.since ? Date.parse(window.since) : -Infinity;
  const hi = window.until ? Date.parse(window.until) : Infinity;
  const items = all.filter((o) => {
    const t = Date.parse(o.at);
    return t >= lo && t < hi;
  });
  const variants = new Map<string, Outcome[]>();
  for (const o of items) {
    const { base, variant } = variantOf(o.workflow);
    if (variant) variants.set(base, [...(variants.get(base) ?? []), o]);
  }
  const compared: VariantComparison[] = [];
  for (const [workflow, list] of [...variants].sort(([a], [b]) => a.localeCompare(b))) {
    const groups = by(list, (o) => variantOf(o.workflow).variant!);
    if (groups.length < 2) continue;
    const priced = groups.filter((g) => g.costPerAccepted !== undefined);
    const cheapest = priced.sort((a, b) => a.costPerAccepted! - b.costPerAccepted!)[0]?.name;
    compared.push({ workflow, variants: groups, ...(cheapest ? { cheapest } : {}) });
  }
  return { window, workflows: by(items, (o) => o.workflow), teams: by(items, (o) => o.team), variants: compared };
}
