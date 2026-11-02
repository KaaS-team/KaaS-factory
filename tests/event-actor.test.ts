import { describe, expect, test } from "bun:test";
import { ACTOR_KINDS, EVENT_ACTOR, FACTORY_EVENTS, stampActor } from "../src/core/event";
import { emitEvent, EventBus } from "../src/engine/bus";
import { FactoryState } from "../src/state";

function bus(sent: { body: string }[]) {
  const state = new FactoryState(":memory:");
  return new EventBus({
    store: state,
    sinks: [{ url: "https://siem.example/in", secretEnv: "SIEM_SECRET" }],
    source: "factory/acme/widgets",
    env: { SIEM_SECRET: "s" },
    autoDeliver: false,
    fetch: async (_url, init) => {
      sent.push({ body: String(init.body) });
      return new Response("ok");
    },
  });
}

describe("event actor", () => {
  test("every factory event has an actor kind", () => {
    expect(Object.keys(EVENT_ACTOR).sort()).toEqual([...FACTORY_EVENTS].sort());
    for (const kind of Object.values(EVENT_ACTOR)) {
      expect(ACTOR_KINDS.includes(kind)).toBe(true);
    }
  });

  test("emitEvent stamps the actor", async () => {
    const sent: { body: string }[] = [];
    const b = bus(sent);
    emitEvent(b, "factory.step.started", { step: "build", startedBy: "schedule" }, "issue/1");
    expect(await b.deliver()).toBe(1);
    expect(sent).toHaveLength(1);
    const ev = JSON.parse(sent[0]!.body);
    expect(ev.data).toEqual({
      step: "build",
      startedBy: "schedule",
      actorKind: "agent",
      onBehalfOf: "schedule",
    });
  });

  test("onBehalfOf follows startedBy", async () => {
    const sent: { body: string }[] = [];
    const b = bus(sent);
    emitEvent(b, "factory.step.started", { step: "build" }, "issue/1");
    expect(await b.deliver()).toBe(1);
    const ev = JSON.parse(sent[0]!.body);
    expect("onBehalfOf" in ev.data).toBe(false);
  });

  test("non-object data is unchanged", () => {
    expect(stampActor("factory.pr.opened", "x")).toBe("x");
  });
});
