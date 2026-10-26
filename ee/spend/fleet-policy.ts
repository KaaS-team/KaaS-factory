// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Fleet-wide spend policy: a daily cap on an org's repos together, and one on every repo the
// policy names, so ten repos under their own caps cannot add up past what the company allows.
import type { SpendPolicy } from "../../src/ports/spend";

export interface FleetSpendConfig {
  // Across every repo named here or in an org.
  readonly dailyUsd?: number;
  readonly repos?: readonly string[];
  readonly orgs?: Readonly<Record<string, { readonly dailyUsd: number; readonly repos: readonly string[] }>>;
}

// A repo's spend since a moment; the caller picks the source (local SQLite, the shared ledger).
export type SpendOf = (repo: string, sinceIso: string) => Promise<number> | number;

export function fleetSpendConfigProblems(c: unknown): string[] {
  const cap = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const repos = (v: unknown) =>
    Array.isArray(v) && v.every((r) => typeof r === "string" && /^[\w.-]+\/[\w.-]+$/.test(r));
  if (typeof c !== "object" || c === null) return ["the spend policy must be an object"];
  const p = c as Record<string, unknown>;
  const out: string[] = [];
  if (p.dailyUsd !== undefined && !cap(p.dailyUsd)) out.push("dailyUsd must be a number of dollars, 0 or more");
  if (p.repos !== undefined && !repos(p.repos)) out.push("repos must be a list of owner/name");
  for (const [name, org] of Object.entries((p.orgs ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!cap(org?.dailyUsd)) out.push(`orgs.${name}.dailyUsd must be a number of dollars, 0 or more`);
    if (!repos(org?.repos)) out.push(`orgs.${name}.repos must be a list of owner/name`);
  }
  return out;
}

export class FleetSpendPolicy implements SpendPolicy {
  constructor(
    private readonly config: FleetSpendConfig,
    private readonly spendOf: SpendOf,
  ) {}

  async breached(repo: string, sinceIso: string): Promise<string | undefined> {
    const total = async (repos: Iterable<string>) => {
      let sum = 0;
      for (const r of new Set(repos)) sum += await this.spendOf(r, sinceIso);
      return sum;
    };
    const orgs = Object.entries(this.config.orgs ?? {});
    for (const [name, org] of orgs) {
      if (!org.repos.includes(repo)) continue;
      const spent = await total(org.repos);
      if (spent >= org.dailyUsd)
        return `org ${name} has spent $${spent.toFixed(2)} today, at or over its $${org.dailyUsd.toFixed(2)} cap`;
    }
    const fleet = [...(this.config.repos ?? []), ...orgs.flatMap(([, o]) => o.repos)];
    // A repo the policy never names is outside the fleet, so the fleet cap does not hold it back.
    if (this.config.dailyUsd === undefined || !fleet.includes(repo)) return undefined;
    const spent = await total(fleet);
    if (spent >= this.config.dailyUsd)
      return `the fleet has spent $${spent.toFixed(2)} today, at or over its $${this.config.dailyUsd.toFixed(2)} cap`;
    return undefined;
  }
}
