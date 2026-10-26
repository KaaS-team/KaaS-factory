// `factory events tail --follow` keeps printing events as they are recorded, in order and once each,
// until it is stopped.

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/engine/bus";
import { tailEvents } from "../src/events-tail";
import { FactoryState } from "../src/state";

describe("events tail", () => {
  test("tail --follow prints events recorded after it started, once each, until stopped", async () => {
    const state = new FactoryState(":memory:");
    const bus = new EventBus({ store: state, sinks: [], source: "factory/o/r", autoDeliver: false });
    bus.emit("factory.issue.ready", { issue: 1 }, "issue/1");
    const lines: string[] = [];
    const controller = new AbortController();
    const done = tailEvents(state, {
      follow: true,
      signal: controller.signal,
      intervalMs: 5,
      write: (l) => lines.push(l),
    });
    await Bun.sleep(20);
    bus.emit("factory.step.started", { issue: 1 }, "issue/1");
    bus.emit("factory.step.completed", { issue: 1 }, "issue/1");
    await Bun.sleep(30);
    controller.abort();
    await done;
    expect(lines.map((l) => l.split("  ")[2])).toEqual([
      "factory.issue.ready",
      "factory.step.started",
      "factory.step.completed",
    ]);
    bus.emit("factory.run.completed", { issue: 1 }, "issue/1");
    await Bun.sleep(20);
    expect(lines).toHaveLength(3);
  });

  test("tail without --follow prints the newest page and returns", async () => {
    const state = new FactoryState(":memory:");
    const bus = new EventBus({ store: state, sinks: [], source: "factory/o/r", autoDeliver: false });
    for (let i = 0; i < 5; i++) bus.emit("factory.issue.ready", { issue: i }, `issue/${i}`);
    const lines: string[] = [];
    await tailEvents(state, { limit: 2, json: true, write: (l) => lines.push(l) });
    expect(lines.map((l) => (JSON.parse(l) as { subject: string }).subject)).toEqual(["issue/3", "issue/4"]);
  });
});
