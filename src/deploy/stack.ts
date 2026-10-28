// `kaas-factory up` with no repo: the control plane, the relay beside it and the blob mirror, as one
// process tree. The image runs exactly this (docker-compose.yml), so a laptop and factory.kaas.team match.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blobStoreFromEnv, mirrorDown } from "../blobs";
import { factoryHome } from "../paths";

const ROOT = join(import.meta.dir, "../..");
const MIRROR_EVERY_MS = 30_000;

// FACTORY_RELAY_* first; KAAS_RELAY_* still works so a deployment set up before the rename keeps its tokens.
export function relaySettings(env: NodeJS.ProcessEnv): {
  bin?: string;
  addr: string;
  publish?: string;
  subscribe?: string;
} {
  return {
    bin: env.FACTORY_RELAY_BIN ?? env.KAAS_RELAY_BIN,
    addr: env.FACTORY_RELAY_ADDR ?? env.KAAS_RELAY_ADDR ?? "127.0.0.1:4200",
    publish: env.FACTORY_RELAY_PUBLISH_TOKEN ?? env.KAAS_RELAY_PUBLISH_TOKEN,
    subscribe: env.FACTORY_RELAY_SUBSCRIBE_TOKEN ?? env.KAAS_RELAY_SUBSCRIBE_TOKEN,
  };
}

export function relayBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = [relaySettings(env).bin, Bun.which("kaas-relay"), join(ROOT, "relay/target/release/kaas-relay")];
  return found.find((p): p is string => !!p && existsSync(p));
}

// Tokens the operator did not set are made per start; the phone's token lands in a 0600 file, never a log.
function relayTokens(env: NodeJS.ProcessEnv): { publish: string; subscribe: string } {
  const { publish, subscribe } = relaySettings(env);
  if (publish && subscribe) return { publish, subscribe };
  const made = { publish: `pub-${crypto.randomUUID()}`, subscribe: `sub-${crypto.randomUUID()}` };
  const home = factoryHome(env);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "relay-subscribe-token"), `${made.subscribe}\n`, { mode: 0o600 });
  console.log(`factory up: relay subscribe token written to ${join(home, "relay-subscribe-token")}`);
  return made;
}

function startRelayProcess(env: NodeJS.ProcessEnv): ReturnType<typeof Bun.spawn> | undefined {
  const bin = relayBinary(env);
  if (!bin) {
    console.log("factory up: no kaas-relay binary, so the relay is off (cargo build --release in relay/)");
    return undefined;
  }
  const addr = relaySettings(env).addr;
  const tokens = relayTokens(env);
  const relay = Bun.spawn([bin], {
    // relay/src/main.rs reads these names.
    env: {
      PATH: env.PATH ?? "",
      KAAS_RELAY_ADDR: addr,
      KAAS_RELAY_PUBLISH_TOKEN: tokens.publish,
      KAAS_RELAY_SUBSCRIBE_TOKEN: tokens.subscribe,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  // The plane publishes the inbox to the relay through dashboard/relay.ts, which reads these.
  env.FACTORY_RELAY_URL ??= `http://${addr.replace(/^0\.0\.0\.0:/, "127.0.0.1:")}`;
  env.FACTORY_RELAY_TOKEN ??= tokens.publish;
  // A dead relay fails the whole process, so Docker's restart policy brings both back together.
  void relay.exited.then((code) => {
    console.error(`factory up: kaas-relay exited (${code}); stopping`);
    process.exit(1);
  });
  return relay;
}

export async function startStack(plane: () => Promise<void>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const relay = startRelayProcess(env);
  // As PID 1 in a container a signal has no default action, so stop the relay and leave by hand.
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      relay?.kill();
      process.exit(0);
    });
  process.on("exit", () => relay?.kill());
  const store = blobStoreFromEnv(env);
  if (store) {
    const tick = () =>
      mirrorDown(store, env).catch((err) =>
        console.error(`[blobs] mirror: ${err instanceof Error ? err.message : err}`),
      );
    void tick();
    setInterval(tick, MIRROR_EVERY_MS);
  }
  await plane();
}
