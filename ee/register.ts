// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Turns the org features on: `bun --preload ./ee/register.ts bin/factory ...`. Each one registers
// only when its settings are present, so preloading this changes nothing until it is configured.
import { existsSync, readFileSync } from "node:fs";
import { registerPlaneExtension } from "../dashboard/plane/extension";
import { defaultStatePath } from "../src/paths";
import { registerSpendPolicy } from "../src/ports/spend";
import { FactoryState } from "../src/state";
import { auditExportExtension } from "./plane/audit-export";
import { orgsExtension } from "./plane/orgs";
import { rolesExtension } from "./plane/roles";
import { ssoExtension } from "./plane/sso";
import { FleetSpendPolicy, fleetSpendConfigProblems } from "./spend/fleet-policy";

export const ORG_MODE_ENV = "FACTORY_ORG_MODE_REPO";
export const SPEND_POLICY_ENV = "FACTORY_SPEND_POLICY";

export function registerEe(env: Record<string, string | undefined> = process.env): void {
  registerPlaneExtension(ssoExtension(env));
  registerPlaneExtension(rolesExtension());
  registerPlaneExtension(auditExportExtension());
  // The value is the plane's own repo: a request naming no repo acts on it.
  if (env[ORG_MODE_ENV]) registerPlaneExtension(orgsExtension(env[ORG_MODE_ENV]));
  const file = env[SPEND_POLICY_ENV];
  if (!file) return;
  const policy = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const problems = fleetSpendConfigProblems(policy);
  if (problems.length) throw new Error(`${SPEND_POLICY_ENV} (${file}): ${problems.join("; ")}`);
  // Each repo's spend as this machine recorded it, in that repo's own state database.
  const states = new Map<string, FactoryState | null>();
  const stateOf = (repo: string) => {
    if (!states.has(repo)) {
      const path = defaultStatePath(env as NodeJS.ProcessEnv, repo);
      states.set(repo, existsSync(path) ? new FactoryState(path) : null);
    }
    return states.get(repo) ?? null;
  };
  registerSpendPolicy(
    new FleetSpendPolicy(
      policy as ConstructorParameters<typeof FleetSpendPolicy>[0],
      (repo, since) => stateOf(repo)?.spendSummary(repo, since).costUsd ?? 0,
    ),
  );
}

registerEe();
