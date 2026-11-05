// The reserve and refill loop: each poll, hold a slot and the run's spend for every ready issue a
// cloud runtime can take, up to the free slots. Nothing here launches; cloudAware does, from the reservation.
import { cloudLedger } from "../cloud";
import { isPlannedBody, parsePlannedIssue } from "../engine/import-plan";
import { type Orchestrate, orchestrateActive, orchestrateOf } from "./config";
import { type PickIssue, planRefill, rankReady } from "./pick";

export const RUNTIME_LABEL = "runtime:";

type Ledger = ReturnType<typeof cloudLedger>;
export interface RefillResult {
  reserved: { issue: number; provider: string }[];
  refused: { issue: number; reason: string }[];
}

// A `runtime:<provider>` label pins the issue to that provider; otherwise roles.build decides.
function orderFor(issue: PickIssue, orch: Orchestrate): string[] {
  const label = issue.labels.find((l) => l.startsWith(RUNTIME_LABEL));
  if (label) return [label.slice(RUNTIME_LABEL.length)];
  return orch.roles.build;
}

export function filesOfBody(body: string): string[] {
  return isPlannedBody(body) ? (parsePlannedIssue(body).plan?.files.map((f) => f.path) ?? []) : [];
}

export function refillCloud(input: {
  ledger: Ledger;
  orch: Orchestrate;
  ready: readonly PickIssue[];
  spentTodayUsd: number;
}): RefillResult {
  const { ledger, orch } = input;
  const out: RefillResult = { reserved: [], refused: [] };
  const todo = input.ready.filter((i) => !ledger.reservation(i.number) && !ledger.session(i.number));
  const max = Object.fromEntries(Object.entries(orch.providers).map(([n, p]) => [n, p.max]));
  for (const issue of rankReady(todo, orch.priority)) {
    const order = orderFor(issue, orch).filter((p) => p !== "local" && orch.providers[p]);
    if (!order.length) continue;
    const plan = planRefill({
      ranked: [issue],
      order,
      max,
      active: ledger.active(),
      localFree: 0,
      // A pinned label means the author chose the runtime, so it needs no planned file list.
      filesOf: (i) => (i.labels.some((l) => l.startsWith(RUNTIME_LABEL)) ? ["."] : filesOfBody(i.body)),
      held: [],
      spendBlocked: false,
    });
    const pick = plan.assign[0];
    if (!pick) continue;
    const held = input.spentTodayUsd + ledger.reservedUsd() + orch.cost.perRunUsd;
    if (held > orch.cost.perDayUsd) {
      out.refused.push({
        issue: issue.number,
        reason: `reserving $${orch.cost.perRunUsd} would put today's spend at $${held.toFixed(2)}, over the $${orch.cost.perDayUsd} cap`,
      });
      continue;
    }
    ledger.reserve(issue.number, pick.provider, orch.cost.perRunUsd);
    out.reserved.push({ issue: issue.number, provider: pick.provider });
  }
  return out;
}

// Called once per poll with the ready issues; a no-op while orchestration is off, so polling is unchanged.
export async function reserveForPoll(
  deps: {
    state: Parameters<typeof orchestrateActive>[0] & import("../state").FactoryState;
    spend?: import("../ports/spend").SpendStore;
  },
  config: import("../config").FactoryConfig,
  ready: readonly { number: number; body?: string | null; labels: readonly { name: string }[] }[],
): Promise<RefillResult | undefined> {
  if (!orchestrateActive(deps.state, config)) return undefined;
  const sinceIso = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  const spentTodayUsd = (await deps.spend?.since(sinceIso))?.costUsd ?? 0;
  return refillCloud({
    ledger: cloudLedger(deps.state, config.repo),
    orch: orchestrateOf(config),
    ready: ready.map((i) => ({ number: i.number, body: i.body ?? "", labels: i.labels.map((l) => l.name) })),
    spentTodayUsd,
  });
}
