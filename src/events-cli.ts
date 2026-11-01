// `factory events tail|replay <id>`: the outbox and inbox, newest last, or one event sent again.

import { resolve } from "node:path";
import { UsageError } from "./cli-output";
import { loadConfig } from "./config";
import { EventBus } from "./engine/bus";
import { tailEvents } from "./events-tail";
import type { CliContext } from "./harness-cli";
import { FactoryState } from "./state";

export async function cmdEvents(c: CliContext): Promise<void> {
  const sub = c.args[1];
  if (sub !== "tail" && sub !== "replay")
    throw new UsageError(
      "usage: factory events (tail [--limit N] [--follow] | replay <id>) --repo-dir <path> [--json]",
    );
  const cloneDir = resolve(c.flag("repo-dir") ?? ".");
  const config = await loadConfig(cloneDir);
  const state = new FactoryState(c.statePath(config.repo));
  if (sub === "tail") {
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    const opts = { limit: Number(c.flag("limit") ?? 50), follow: c.has("follow"), json: c.has("json") };
    return tailEvents(state, { ...opts, signal: controller.signal });
  }
  const id = c.args[2];
  if (!id || id.startsWith("--")) throw new UsageError("events replay: an event id is required");
  const bus = new EventBus({
    store: state,
    sinks: config.events.sinks,
    source: `factory/${config.repo}`,
    autoDeliver: false,
  });
  const queued = bus.replay(id);
  if (!queued) throw new UsageError(`events replay: no event "${id}" with a configured sink`);
  const delivered = await bus.deliver();
  console.log(`factory events: ${id} queued to ${queued} sink(s), ${delivered} delivered now`);
}
