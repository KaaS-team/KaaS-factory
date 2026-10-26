// The live runtime suite's targets: a real box over ssh, a real launcher (Firecracker, gVisor) and a
// hosted sandbox. The keys match each manifest's live block, and the suite skips a target while any
// is unset. The ssh box must already trust this machine's key.
import type { RuntimeSpec } from "../../src/runtimes";

type Env = Readonly<Record<string, string | undefined>>;
export interface LiveRuntime {
  readonly env: readonly string[];
  readonly spec: (env: Env) => Exclude<RuntimeSpec, { kind: "pool" }>;
}

export const LIVE_RUNTIMES: Readonly<Record<string, LiveRuntime>> = {
  ssh: {
    env: ["FACTORY_LIVE_SSH_HOST", "FACTORY_LIVE_SSH_DIR"],
    spec: (e) => ({ kind: "ssh", host: e.FACTORY_LIVE_SSH_HOST!, dir: e.FACTORY_LIVE_SSH_DIR! }),
  },
  // A JSON argv with one "{cmd}", such as ["firecracker-run", "--", "bash", "-c", "{cmd}"].
  wrap: {
    env: ["FACTORY_LIVE_WRAP_ARGV"],
    spec: (e) => ({ kind: "wrap", argv: JSON.parse(e.FACTORY_LIVE_WRAP_ARGV!) as string[] }),
  },
  "http-sandbox": {
    env: ["FACTORY_LIVE_SANDBOX_URL", "FACTORY_LIVE_SANDBOX_TOKEN"],
    spec: (e) => ({ kind: "http", url: e.FACTORY_LIVE_SANDBOX_URL!, tokenEnv: "FACTORY_LIVE_SANDBOX_TOKEN" }),
  },
};
