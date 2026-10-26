// `emit:` chains workflows: when one ships it emits factory.workflow.emitted with its emit name, and
// every workflow whose on.emitted lists that name files its own ready issue from it.

import { afterAll, describe, expect, test } from "bun:test";
import type { CloudEvent } from "../src/core/event";
import { EventBus } from "../src/engine/bus";
import { parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { handleEvent } from "../src/watch";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const parse = (text: string) => {
  const r = parseWorkflowText(text);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
};

const DOCS = parse(`---
name: docs
emit: docs-shipped
stages:
  triage: {}
  build: { needs: triage }
  pr: { needs: build }
---
`);

const NOTES = parse(`---
name: release-notes
on:
  emitted: docs-shipped
stages:
  triage: {}
  build: { needs: triage }
  pr: { needs: build }
---
`);

describe("emit chaining", () => {
  test("a shipped workflow's emit files a ready issue for the workflow listening on.emitted", async () => {
    const state = new FactoryState(":memory:");
    const bus = new EventBus({ store: state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
    const heard: CloudEvent[] = [];
    bus.subscribe("factory.workflow.emitted", (e) => void heard.push(e));
    const e = engine(DOCS, 0, {}, {}, { state, bus, routeWorkflows: { "release-notes": NOTES } });
    expect(await e.run()).toBe("shipped");
    expect(heard.map((h) => (h.data as { emit: string }).emit)).toEqual(["docs-shipped"]);

    expect(await handleEvent(e.deps, e.config, heard[0]!)).toBe(1);
    const filed = [...e.github.issues.values()].find((i) => i.number !== 1)!;
    expect(filed.labels.map((l) => l.name)).toEqual([LABEL.ready]);
    expect(filed.body).toContain("release-notes");
    // The emitting workflow does not listen for itself, and a replayed event files nothing twice.
    expect(await handleEvent(e.deps, e.config, heard[0]!)).toBe(0);
  });

  test("emit and on.emitted take only names", () => {
    const r = parseWorkflowText(`---
name: bad
emit: "no spaces allowed"
on:
  emitted: []
stages:
  triage: {}
---
`);
    expect(r.ok ? [] : r.problems).toEqual(
      expect.arrayContaining([
        "emit: a name other workflows' on.emitted can match",
        "on.emitted: an emit name, or a list of them",
      ]),
    );
  });
});
