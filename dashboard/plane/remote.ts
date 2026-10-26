// Everything that lets the factory be steered away from the desk, built from the plane's own
// database: paired phones, dial-out runners, web push and the sealer the relay publishes through.
// server.ts spreads `routes` into its table and calls `start()` only when it really serves.
import { join, dirname } from "node:path";
import type { ScmPort } from "../../src/github";
import { loadE2EKey, newE2EKey, seal, type E2EKey } from "../../src/e2e";
import { SqliteStore } from "../../src/adapters/sqlite/store";
import { WebPushNotifier } from "../../src/adapters/webpush/notifier";
import type { createAccess } from "./access";
import { DeviceStore, deviceRoutes } from "./devices";
import { pushTicker } from "./push";
import { RunnerHub, HEARTBEAT_MS } from "./runners";
import { RUNNER_ROUTES, runnerRoutes } from "./runner-routes";
import { startRelay } from "../relay";

// Reached without a session: each checks a runner secret or spends a one-time pairing token itself.
export const REMOTE_PUBLIC_ROUTES: readonly string[] = [...RUNNER_ROUTES, "POST /api/pair/claim"];
// Writes a viewer may make, because they touch only the caller's own phones and notifications.
export const SELF_SERVICE_ROUTES: readonly string[] = [
  "POST /api/pair",
  "POST /api/devices/revoke",
  "POST /api/push/subscribe",
  "POST /api/push/unsubscribe",
  "POST /api/presence",
];
export const PUSH_SUBJECT_ENV = "FACTORY_PUSH_SUBJECT";
const PUSH_EVERY_MS = 10_000;

export interface RemoteDeps {
  access: ReturnType<typeof createAccess>;
  github: Pick<ScmPort, "commentIssue">;
  repo: string;
  handle: (req: Request) => Promise<Response>;
  env?: Record<string, string | undefined>;
  send?: typeof fetch;
  now?: () => number;
}

export function createRemote(deps: RemoteDeps) {
  const now = deps.now ?? Date.now;
  const store = deps.access.store;
  const db = store.database;
  const devices = new DeviceStore(db, now);
  const hub = new RunnerHub(db, now);
  // The factory's key lives beside plane.db; an in-memory plane (tests) gets a fresh one.
  let key: Promise<E2EKey> | undefined;
  const e2eKey = () =>
    (key ??= store.path === ":memory:" ? newE2EKey() : loadE2EKey(join(dirname(store.path), "e2e-key.json")));
  const env = deps.env ?? process.env;
  const notifier = new WebPushNotifier(
    new SqliteStore(db),
    env[PUSH_SUBJECT_ENV] || "https://github.com/KaaS-team/software-factory",
    deps.send,
    now,
  );
  const push = pushTicker(
    deps.handle,
    {
      notifier,
      publicKey: () => notifier.publicKey(),
      subscribe: (s) => notifier.subscribe(s),
      unsubscribe: (e) => notifier.unsubscribe(e),
    },
    now,
  );
  const roleOf = (login: string) => store.roleOf(login);

  // What the relay forwards: a box only paired devices open, or nothing when none is paired.
  const sealer = async (plaintext: string) => {
    const to = devices.recipients();
    return to.length ? JSON.stringify({ sealed: await seal(plaintext, await e2eKey(), to) }) : undefined;
  };

  const routes = [
    ...deviceRoutes({
      devices,
      actorOf: deps.access.actorOf,
      senderKey: async () => (await e2eKey()).publicKey,
      roleOf,
      startSession: deps.access.startSession,
    }),
    ...runnerRoutes({ hub, github: deps.github, repo: deps.repo, actorOf: deps.access.actorOf }),
    ...push.routes,
  ];

  function start(env: Record<string, string | undefined> = process.env): void {
    startRelay(deps.handle, env, 10_000, sealer);
    setInterval(() => hub.sweep(), HEARTBEAT_MS).unref();
    setInterval(() => void push.tick().catch(() => []), PUSH_EVERY_MS).unref();
  }

  return { routes, devices, hub, notifier, push, sealer, e2eKey, start };
}
