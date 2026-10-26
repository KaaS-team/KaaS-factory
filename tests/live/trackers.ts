// The live tracker suite's vendors, each with the env keys that point it at a real workspace. The
// keys match each manifest's live block (tests/integrations.test.ts), and the suite skips a vendor
// while any is unset. Point it at an empty project: the contract counts the open issues it sees.
import type { TrackerConfig } from "../../src/config";

type Env = Readonly<Record<string, string | undefined>>;
export interface LiveTracker {
  readonly env: readonly string[];
  readonly config: (env: Env) => TrackerConfig;
}

export const LIVE_TRACKERS: Readonly<Record<string, LiveTracker>> = {
  linear: {
    env: ["FACTORY_LIVE_LINEAR_KEY", "FACTORY_LIVE_LINEAR_TEAM"],
    config: (e) => ({ kind: "linear", team: e.FACTORY_LIVE_LINEAR_TEAM!, tokenEnv: "FACTORY_LIVE_LINEAR_KEY" }),
  },
  jira: {
    env: ["FACTORY_LIVE_JIRA_URL", "FACTORY_LIVE_JIRA_PROJECT", "FACTORY_LIVE_JIRA_TOKEN"],
    config: (e) => ({
      kind: "jira",
      url: e.FACTORY_LIVE_JIRA_URL!,
      project: e.FACTORY_LIVE_JIRA_PROJECT!,
      tokenEnv: "FACTORY_LIVE_JIRA_TOKEN",
    }),
  },
  plane: {
    env: ["FACTORY_LIVE_PLANE_WORKSPACE", "FACTORY_LIVE_PLANE_PROJECT", "FACTORY_LIVE_PLANE_KEY"],
    config: (e) => ({
      kind: "plane",
      workspace: e.FACTORY_LIVE_PLANE_WORKSPACE!,
      project: e.FACTORY_LIVE_PLANE_PROJECT!,
      tokenEnv: "FACTORY_LIVE_PLANE_KEY",
    }),
  },
  clickup: {
    env: ["FACTORY_LIVE_CLICKUP_WORKSPACE", "FACTORY_LIVE_CLICKUP_LIST", "FACTORY_LIVE_CLICKUP_TOKEN"],
    config: (e) => ({
      kind: "clickup",
      workspace: e.FACTORY_LIVE_CLICKUP_WORKSPACE!,
      list: e.FACTORY_LIVE_CLICKUP_LIST!,
      tokenEnv: "FACTORY_LIVE_CLICKUP_TOKEN",
    }),
  },
  asana: {
    env: ["FACTORY_LIVE_ASANA_WORKSPACE", "FACTORY_LIVE_ASANA_PROJECT", "FACTORY_LIVE_ASANA_TOKEN"],
    config: (e) => ({
      kind: "asana",
      workspace: e.FACTORY_LIVE_ASANA_WORKSPACE!,
      project: e.FACTORY_LIVE_ASANA_PROJECT!,
      tokenEnv: "FACTORY_LIVE_ASANA_TOKEN",
    }),
  },
};

// The first unset key, named in the skip so a reader knows what to set.
export const missingKey = (keys: readonly string[], env: Env) => keys.find((k) => !env[k]);
