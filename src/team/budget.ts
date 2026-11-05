// A team's monthly cap: the month's spend across the team's own repos, so one team never draws
// on another team's budget. Intake stops at the cap; work already in flight is left alone.
import { existsSync } from "node:fs";
import type { FactoryConfig } from "../config";
import type { InboxItem } from "../inbox";
import { FactoryState } from "../state";

export interface TeamBudget {
  readonly name: string;
  readonly monthlyUsd: number;
  readonly repos: readonly string[];
}

export const startOfMonthUtc = (now: Date = new Date()): string =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export interface MonthlySpend {
  spendSummary(repo: string, sinceIso: string): { costUsd: number };
}

// The cap as a team file states it: the policy value and the team's own, whichever is lower.
export function teamCapUsd(...caps: readonly (number | undefined)[]): number | undefined {
  const set = caps.filter((c): c is number => typeof c === "number");
  return set.length ? Math.min(...set) : undefined;
}

export function teamBudgetHit(
  state: MonthlySpend,
  config: Pick<FactoryConfig, "spend">,
  now: Date = new Date(),
): string | undefined {
  const budget = config.spend.team;
  if (!budget) return undefined;
  const since = startOfMonthUtc(now);
  const spent = budget.repos.reduce((sum, repo) => sum + state.spendSummary(repo, since).costUsd, 0);
  if (spent < budget.monthlyUsd) return undefined;
  return `team ${budget.name} has spent $${spent.toFixed(2)} this month, at or over its monthly cap of $${budget.monthlyUsd.toFixed(2)}; new work waits until next month or a higher cap`;
}

export function teamBudgetItems(db: string, config: Pick<FactoryConfig, "spend"> | undefined): InboxItem[] {
  const team = config?.spend.team;
  const reason = team && existsSync(db) ? teamBudgetHit(new FactoryState(db), { spend: { team } }) : undefined;
  return team && reason ? [teamBudgetItem(reason, team.name)] : [];
}

export function teamBudgetItem(reason: string, team: string): InboxItem {
  return {
    id: `team-budget-${team}`,
    kind: "budget",
    issue: 0,
    title: `Team ${team} is over its monthly budget`,
    label: "",
    waitingSince: undefined,
    ask: reason,
    actions: [],
  };
}
