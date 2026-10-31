// The live doctor checks, in output order. A feature adds its check by appending one entry here,
// so src/cli.ts never changes when a check does (tests/doctor-checks.test.ts pins both).
import { accessSync, constants } from "node:fs";
import type { FactoryConfig } from "./config";
import { type DoctorCheck, runDoctor } from "./doctor";
import { GitCommandRunner } from "./git";
import { mergeMethodCheck } from "./merge-method";
import { loadMachineConfig } from "./machine";
import { defaultStatePath, workspacesDir as defaultWorkspacesDir } from "./paths";
import { versionOf, which } from "./probes";
import { probeNamed, probeRuntime } from "./runtime-kit";
import { runtimesFrom } from "./runtimes";
import type { makeScm } from "./scm";
import { templateSkills } from "./template-root";

export interface DoctorEnv {
  readonly cloneDir: string;
  readonly github: ReturnType<typeof makeScm>;
}
export type DoctorCheckSource = (config: FactoryConfig, env: DoctorEnv) => Promise<DoctorCheck[]>;

const fileExists = async (path: string): Promise<boolean> => await Bun.file(path).exists();

const coreChecks: DoctorCheckSource = (config, { cloneDir, github }) =>
  runDoctor(
    {
      github,
      tracker: { kind: github.trackerKind, authStatus: () => github.tracker.authStatus() },
      git: new GitCommandRunner(),
      which,
      versionOf,
      fileExists,
      readFile: async (path) => ((await fileExists(path)) ? await Bun.file(path).text() : undefined),
      probeRuntime: (name, bins) =>
        probeNamed(loadMachineConfig().runtimes, name, 10_000, (port, ms) => probeRuntime(port, ms, bins)),
      isExecutable: async (path) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      repo: config.repo,
      cloneDir,
      baselineTag: config.baselineTag,
      factoryMode: process.env.FACTORY_MODE,
      agents: config.agents,
      stages: config.stages,
      routes: config.routes,
      templateSkills: templateSkills(),
      templateOverrides: config.templateOverrides,
      workflow: config.workflow,
      runtime: config.runtime,
      runtimeNames: Object.keys(runtimesFrom(loadMachineConfig().runtimes)),
      tmux: config.tmux.enabled,
      legacyStatePath: defaultStatePath(process.env),
      legacyWorkspacesDir: defaultWorkspacesDir(process.env),
      configuredSlots: loadMachineConfig().slots,
      resettable: config.resettable,
    },
  );

const mergeMethod: DoctorCheckSource = async (config) => [await mergeMethodCheck(config)];

export const DOCTOR_CHECKS: readonly DoctorCheckSource[] = [coreChecks, mergeMethod];

export async function liveDoctorChecks(
  config: FactoryConfig,
  env: DoctorEnv,
  sources: readonly DoctorCheckSource[] = DOCTOR_CHECKS,
): Promise<DoctorCheck[]> {
  const rows: DoctorCheck[] = [];
  for (const source of sources) rows.push(...(await source(config, env)));
  return rows;
}
