import { describe, expect, test } from "bun:test";
import { mergeConfig } from "../src/config";
import { CRON_CATCHUP_MINUTES, cronMarker, eventMarker, fireCron, fireEvent } from "../src/engine/triggers";
import type { CloudEvent } from "../src/core/event";
import { defaultWorkflow, parseWorkflowText } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { handleEvent, pollOnce } from "../src/watch";
import { FakeGitHub } from "./harness";

const REPO = "o/r";
const BASE = `name: nightly
steps:
  triage:
    uses: triage
    label: factory:triaging
    next: plan
  plan:
    uses: plan
    label: factory:planning
    next: pr
  pr:
    uses: pr
    label: factory:in-review
`;
const withOn = (on: string) => BASE.replace("steps:", `on:\n${on}\nsteps:`);

function nightly(
  on = `  cron:\n    - schedule: "0 2 * * *"\n      title: Nightly dependency check\n      body: Bump what is safe.`,
) {
  const r = parseWorkflowText(withOn(on));
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.workflow;
}

class Store {
  kv = new Map<string, string>();
  getSetting(k: string) {
    return this.kv.get(k);
  }
  setSetting(k: string, v: string) {
    this.kv.set(k, v);
  }
}

describe("workflow on:", () => {
  test("no on: means no triggers; the bundled workflow has none", () => {
    expect(defaultWorkflow().triggers.cron).toEqual([]);
  });

  test("parses a cron trigger, UTC by default", () => {
    const [t] = nightly().triggers.cron;
    expect(t!.cron.src).toBe("0 2 * * *");
    expect(t!.tz).toBe("UTC");
    expect(t!.title).toBe("Nightly dependency check");
  });

  test.each([
    [`  cron:\n    - schedule: "0 2 * *"\n      title: x`, /on\.cron\[0\]\.schedule: .*5 fields/],
    [`  cron:\n    - schedule: "0 2 * * *"\n      tz: Moon/Base\n      title: x`, /on\.cron\[0\]\.tz: .*IANA/],
    [`  cron:\n    - schedule: "0 2 * * *"`, /on\.cron\[0\]\.title: required/],
    [`  cron:\n    - schedule: "0 2 * * *"\n      title: x\n      when: now`, /on\.cron\[0\]\.when: unknown key/],
    [`  push: main`, /on\.push: unknown key/],
    [`  cron: "0 2 * * *"`, /on\.cron: a list/],
  ])("names the problem: %#", (on, msg) => {
    const r = parseWorkflowText(withOn(on));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(msg);
  });
});

describe("fireCron under a fake clock", () => {
  const at = (iso: string) => new Date(iso);

  test("files one ready issue in the matching minute, with its marker", async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    expect(await fireCron(gh, store, REPO, nightly(), at("2026-10-09T01:59:10Z"))).toEqual([]);
    const filed = await fireCron(gh, store, REPO, nightly(), at("2026-10-09T02:00:30Z"));
    expect(filed).toHaveLength(1);
    const issue = gh.issues.get(filed[0]!)!;
    expect(issue.title).toBe("Nightly dependency check");
    expect(issue.labels.map((l) => l.name)).toEqual([LABEL.ready]);
    expect(issue.body).toContain("Bump what is safe.");
    expect(issue.body).toContain(cronMarker("nightly", 0));
  });

  test("a poll that skipped past the minute still catches it", async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    await fireCron(gh, store, REPO, nightly(), at("2026-10-09T01:58:00Z"));
    // Next poll lands four minutes later; 02:00 was in between.
    expect(await fireCron(gh, store, REPO, nightly(), at("2026-10-09T02:02:00Z"))).toHaveLength(1);
  });

  test("the same minute polled twice files once", async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    await fireCron(gh, store, REPO, nightly(), at("2026-10-09T01:59:00Z"));
    await fireCron(gh, store, REPO, nightly(), at("2026-10-09T02:00:05Z"));
    gh.issues.forEach((i) => (i.state = "CLOSED"));
    expect(await fireCron(gh, store, REPO, nightly(), at("2026-10-09T02:00:50Z"))).toEqual([]);
  });

  test("an open issue from the same trigger blocks the next one; closing it unblocks", async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    const every = nightly(`  cron:\n    - schedule: "*/5 * * * *"\n      title: Sweep`);
    await fireCron(gh, store, REPO, every, at("2026-10-09T02:04:00Z"));
    expect(await fireCron(gh, store, REPO, every, at("2026-10-09T02:05:00Z"))).toHaveLength(1);
    expect(await fireCron(gh, store, REPO, every, at("2026-10-09T02:10:00Z"))).toEqual([]);
    gh.issues.forEach((i) => (i.state = "CLOSED"));
    expect(await fireCron(gh, store, REPO, every, at("2026-10-09T02:15:00Z"))).toHaveLength(1);
  });

  test(`a long sleep catches up at most ${CRON_CATCHUP_MINUTES} minutes`, async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    await fireCron(gh, store, REPO, nightly(), at("2026-10-08T01:00:00Z"));
    // 02:00 yesterday is long gone; 02:00 today is outside the window too.
    expect(await fireCron(gh, store, REPO, nightly(), at("2026-10-09T03:30:00Z"))).toEqual([]);
    expect(await fireCron(gh, store, REPO, nightly(), at("2026-10-10T02:30:00Z"))).toHaveLength(1);
  });

  test("first boot checks only the current minute, not the past hour", async () => {
    const gh = new FakeGitHub([]);
    expect(await fireCron(gh, new Store(), REPO, nightly(), at("2026-10-09T02:30:00Z"))).toEqual([]);
    expect(await fireCron(gh, new Store(), REPO, nightly(), at("2026-10-09T02:00:00Z"))).toHaveLength(1);
  });

  test("the schedule reads its own zone", async () => {
    const gh = new FakeGitHub([]);
    const store = new Store();
    const ist = nightly(`  cron:\n    - schedule: "0 9 * * *"\n      tz: Asia/Kolkata\n      title: Standup digest`);
    expect(await fireCron(gh, store, REPO, ist, at("2026-10-09T09:00:00Z"))).toEqual([]);
    expect(await fireCron(gh, store, REPO, ist, at("2026-10-10T03:30:00Z"))).toHaveLength(1);
  });

  test("the watcher's poll runs the configured workflow's schedule", async () => {
    const gh = new FakeGitHub([]);
    const state = new FactoryState(":memory:");
    // Intake paused: the schedule still files its issue, which waits in factory:ready.
    state.setToggle("auto_start", false);
    const deps = { github: gh, state, workflow: nightly(), now: () => at("2026-10-09T02:00:00Z") } as never;
    await pollOnce(deps, mergeConfig({ repo: REPO }));
    expect([...gh.issues.values()].map((i) => i.title)).toEqual(["Nightly dependency check"]);
  });
});

const wikiEvent = (id = "ev-1"): CloudEvent => ({
  specversion: "1.0",
  id,
  source: "wiki",
  type: "wiki.page.updated",
  subject: "pages/setup",
  time: "2026-10-11T00:00:00Z",
  data: { page: "setup" },
});

describe("workflow on: event", () => {
  test("takes one type or a list, each from the catalogue", () => {
    expect(nightly(`  event: wiki.page.updated`).triggers.event).toEqual(["wiki.page.updated"]);
    expect(nightly(`  event: [tasks.task.ready, wiki.page.updated]`).triggers.event).toEqual([
      "tasks.task.ready",
      "wiki.page.updated",
    ]);
    expect(defaultWorkflow().triggers.event).toEqual([]);
  });

  test.each([
    [`  event: wiki.page.deleted`, /on\.event: "wiki\.page\.deleted" is not an event type/],
    [`  event: []`, /on\.event: an event type, or a list/],
    [`  event: 3`, /on\.event: an event type, or a list/],
  ])("names the problem: %#", (on, msg) => {
    const r = parseWorkflowText(withOn(on));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(msg);
  });

  test("another app's event files one unlabelled issue per event id, carrying the data and its marker", async () => {
    const gh = new FakeGitHub([]);
    const wf = nightly(`  event: wiki.page.updated`);
    const n = await fireEvent(gh, REPO, wf, wikiEvent());
    expect(n).toBeDefined();
    const issue = gh.issues.get(n!)!;
    expect(issue.title).toBe("wiki.page.updated: pages/setup");
    // A valid HMAC proves the sender, not the data: a maintainer adds factory:ready, and pickup checks who did.
    expect(issue.labels).toEqual([]);
    expect(issue.body).toContain(`adds \`${LABEL.ready}\` to run it`);
    expect(issue.body).toContain('"page": "setup"');
    expect(issue.body).toContain(eventMarker("nightly", "ev-1"));
    // The same event again (a redelivery) files nothing; a new id files again.
    expect(await fireEvent(gh, REPO, wf, wikiEvent())).toBeUndefined();
    expect(await fireEvent(gh, REPO, wf, wikiEvent("ev-2"))).toBeDefined();
    // A type the workflow does not listen for files nothing.
    expect(await fireEvent(gh, REPO, wf, { ...wikiEvent("ev-3"), type: "tasks.task.ready" })).toBeUndefined();
  });

  test("the factory's own event files a factory:ready issue", async () => {
    const gh = new FakeGitHub([]);
    const wf = nightly(`  event: factory.pr.merged`);
    const n = await fireEvent(gh, REPO, wf, { ...wikiEvent(), type: "factory.pr.merged", source: "factory/o/r" });
    expect(gh.issues.get(n!)!.labels.map((l) => l.name)).toEqual([LABEL.ready]);
  });

  test("an inbound event never starts a run by itself: the poll picks nothing up", async () => {
    const gh = new FakeGitHub([]);
    const deps = {
      github: gh,
      state: new FactoryState(":memory:"),
      workflow: nightly(`  event: tasks.task.ready`),
    } as never;
    expect(await handleEvent(deps, mergeConfig({ repo: REPO }), { ...wikiEvent(), type: "tasks.task.ready" })).toBe(1);
    expect((await pollOnce(deps, mergeConfig({ repo: REPO }))).processed).toEqual([]);
  });

  test("handleEvent files for a routed workflow and records which workflow runs it", async () => {
    const gh = new FakeGitHub([]);
    const routed = parseWorkflowText(withOn(`  event: wiki.page.updated`).replace("name: nightly", "name: docs-sync"));
    if (!routed.ok) throw new Error(routed.problems.join("\n"));
    const deps = {
      github: gh,
      state: new FactoryState(":memory:"),
      workflow: defaultWorkflow(),
      routeWorkflows: { docs: routed.workflow },
    } as never;
    expect(await handleEvent(deps, mergeConfig({ repo: REPO }), wikiEvent())).toBe(1);
    const [issue] = [...gh.issues.values()];
    expect(issue!.comments.map((c) => c.body).join("\n")).toContain('"name":"docs-sync"');
  });
  test("an issue a routed workflow's schedule files records that workflow, so pickup runs it", async () => {
    const gh = new FakeGitHub([]);
    const routed = parseWorkflowText(
      withOn(`  cron:\n    - schedule: "0 2 * * *"\n      title: Deps`).replace("name: nightly", "name: deps"),
    );
    if (!routed.ok) throw new Error(routed.problems.join("\n"));
    const state = new FactoryState(":memory:");
    state.setToggle("auto_start", false);
    const deps = {
      github: gh,
      state,
      workflow: defaultWorkflow(),
      routeWorkflows: { deps: routed.workflow },
      now: () => new Date("2026-10-09T02:00:00Z"),
    } as never;
    await pollOnce(deps, mergeConfig({ repo: REPO }));
    const [issue] = [...gh.issues.values()];
    expect(issue!.comments.map((c) => c.body).join("\n")).toContain('"name":"deps"');
  });
});
