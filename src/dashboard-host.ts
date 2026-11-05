// The seam between the core and the dashboard package. The core never imports the dashboard: it
// asks for the package by name, and the package hands back a function that starts a server. With
// the package absent, every other command still runs and `dashboard` says what is missing.
import type { FactoryConfig } from "./config";
import type { Git } from "./git";
import type { MachineConfig, MachineLeases } from "./machine";
import type { ScmPort } from "./ports/scm";
import type { Health } from "./runtime-kit";
import type { FactoryState } from "./state";
import { isMissingPackage } from "./plugins/loader";

export const DASHBOARD_PACKAGE = "@kaas-team/factory-dashboard";

// What the dashboard needs to know about the repo it serves. Absent when it
// was started without --repo-dir: the pages then say so instead of guessing.
export interface DashboardProject {
  readonly cloneDir: string;
  readonly config: FactoryConfig;
  readonly machine: MachineConfig;
  // Every lease ref on the remote; GitLeases.held in production.
  readonly leases: () => Promise<ReadonlyArray<{ key: string; holder: string; expiresAt: number }>>;
  // This machine's slot leases and the fleet's heartbeats (FACTORY_HOME/machine.db).
  readonly fleet?: Pick<MachineLeases, "holders" | "machines">;
  // Tests stand in for probeRuntime here; production probes the runtime itself.
  readonly probe?: (runtime: string) => Promise<Health>;
  // The git a workflow edit branches with; a real one when absent.
  readonly git?: Git;
  // The copy a runner shipped (src/blobs.ts): no clone to branch from or list leases with.
  readonly readOnly?: true;
}

export interface DashboardServerOptions {
  readonly state: FactoryState;
  readonly github: ScmPort;
  readonly repo: string;
  readonly autoApproveDefault: boolean;
  readonly fleet?: Pick<FactoryConfig, "agents" | "stages">;
  readonly project?: DashboardProject;
  readonly port: number;
  readonly hostname: string;
}

// Starts the dashboard and returns the port it listens on.
export type DashboardServerFactory = (options: DashboardServerOptions) => number;

export class DashboardMissing extends Error {}

type Importer = (name: string) => Promise<{ createDashboardServer?: unknown }>;

// The factory the dashboard package exports, or a DashboardMissing that names the package.
export async function loadDashboard(importer: Importer = (name) => import(name)): Promise<DashboardServerFactory> {
  let mod: { createDashboardServer?: unknown };
  try {
    mod = await importer(DASHBOARD_PACKAGE);
  } catch (err) {
    if (isMissingPackage(err, DASHBOARD_PACKAGE))
      throw new DashboardMissing(`the dashboard package ${DASHBOARD_PACKAGE} is not installed`);
    throw err;
  }
  if (typeof mod.createDashboardServer !== "function")
    throw new DashboardMissing(`${DASHBOARD_PACKAGE} does not export createDashboardServer`);
  return mod.createDashboardServer as DashboardServerFactory;
}

// Starts the dashboard through the package, using the port and host the environment names.
export async function serveDashboard(
  options: Omit<DashboardServerOptions, "port" | "hostname">,
  port: number,
  env: Record<string, string | undefined> = process.env,
  importer?: Importer,
): Promise<number> {
  const serve = await loadDashboard(importer);
  return serve({ ...options, port, hostname: env.FACTORY_DASHBOARD_HOST ?? "127.0.0.1" });
}
