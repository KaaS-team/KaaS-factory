// The Events, Minions and workflow-form routes: the outbox with each event's deliveries and a
// replay that sends it again, every minion with its last run, and a workflow edit that becomes a PR
// while the repo's own workflow file stays as it was.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard } from "../dashboard/server";
import type { DashboardProject } from "../dashboard/project";
import { formFrom } from "../dashboard/public/lib/workflow-pages.js";
import { mergeConfig } from "../src/config";
import { EventBus } from "../src/engine/bus";
import { parseWorkflowText } from "../src/engine/workflows";
import { FactoryState } from "../src/state";
import { FakeGit, FakeGitHub } from "./harness";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const received: string[] = [];
const sink = Bun.serve({
  port: 0,
  fetch: async (req) => {
    received.push(((await req.json()) as { id: string }).id);
    return new Response("ok");
  },
});
afterAll(() => {
  sink.stop(true);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const cloneDir = tmp("wf-pages-clone-");
  const config = mergeConfig({
    repo: "acme/widgets",
    events: { sinks: [{ url: `http://127.0.0.1:${sink.port}/in`, secretEnv: "SINK_SECRET" }] },
  });
  const git = new FakeGit();
  const project: DashboardProject = {
    cloneDir,
    config,
    machine: { slots: 1 } as DashboardProject["machine"],
    leases: async () => [],
    git,
  };
  const state = new FactoryState(":memory:");
  const github = new FakeGitHub([]);
  const workspaces = tmp("wf-pages-ws-");
  const dash = createDashboard(state, github, "acme/widgets", false, workspaces, undefined, undefined, project);
  const call = (method: string, path: string, body?: unknown) =>
    dash.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      }),
      "127.0.0.1",
    );
  return { cloneDir, config, git, state, github, workspaces, call };
}

describe("events page", () => {
  test("the Events page lists each event with its deliveries, and Replay sends one event to its sinks again", async () => {
    process.env.SINK_SECRET = "s";
    const s = setup();
    const bus = new EventBus({
      store: s.state,
      sinks: s.config.events.sinks,
      source: "factory/acme/widgets",
      autoDeliver: false,
      log: () => {},
    });
    bus.emit("factory.issue.ready", { issue: 4 }, "issue/4");
    await bus.deliver();
    const listed = (await (await s.call("GET", "/api/events")).json()) as {
      events: { id: string; type: string; deliveries: { status: string }[] }[];
    };
    expect(listed.events.map((e) => [e.type, e.deliveries.map((d) => d.status)])).toEqual([
      ["factory.issue.ready", ["delivered"]],
    ]);
    const id = listed.events[0]!.id;
    expect(received).toEqual([id]);
    const res = await s.call("POST", `/api/events/${id}/replay`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: 1, delivered: 1 });
    expect(received).toEqual([id, id]);
    expect((await s.call("POST", "/api/events/nope/replay", {})).status).toBe(404);
  });
});

describe("minions page", () => {
  test("the Minions page lists every minion, what starts it, its workspace and its last run", async () => {
    const s = setup();
    mkdirSync(join(s.cloneDir, ".factory", "minions"), { recursive: true });
    writeFileSync(
      join(s.cloneDir, ".factory", "minions", "reader.yml"),
      "name: reader\ndescription: Reads the code\non:\n  event: tasks.task.updated\nprompt: p\ncheckout: true\n",
    );
    const bus = new EventBus({ store: s.state, sinks: [], source: "f", autoDeliver: false, log: () => {} });
    bus.emit(
      "factory.minion.completed",
      { repo: "acme/widgets", minion: "reader", ok: false, reason: "no JSON" },
      "minion/reader",
    );
    const body = (await (await s.call("GET", "/api/minions")).json()) as {
      minions: { name: string; on: unknown; checkout: boolean; lastRun: { ok: boolean; reason: string } }[];
    };
    expect(body.minions).toHaveLength(1);
    expect(body.minions[0]).toMatchObject({
      name: "reader",
      on: { event: "tasks.task.updated" },
      checkout: true,
      lastRun: { ok: false, reason: "no JSON" },
    });
  });
});

describe("workflow editor", () => {
  test("the workflow form opens a PR with the edited file and never writes the repo's own workflow", async () => {
    const s = setup();
    const own = join(s.cloneDir, ".factory", "workflows", "feature-to-pr.yml");
    mkdirSync(join(s.cloneDir, ".factory", "workflows"), { recursive: true });
    const before = readFileSync(
      join(import.meta.dir, "..", "template", ".factory", "workflows", "feature-to-pr.yml"),
      "utf8",
    );
    writeFileSync(own, before);
    const form = formFrom([
      ["build", "agent", " codex "],
      ["build", "timeout", "45"],
      ["check", "retries", "2"],
      ["verify", "timeout", ""],
    ]);
    expect(form).toEqual({ build: { agent: "codex", timeout: 45 }, check: { retries: 2 } });
    delete (form as Record<string, unknown>).check;
    const res = await s.call("POST", "/api/workflow-edit", { name: "feature-to-pr", form });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { prUrl: string; branch: string };
    expect(s.github.createdPrs).toHaveLength(1);
    expect(s.github.createdPrs[0]).toMatchObject({
      head: out.branch,
      base: "main",
      title: "factory: edit workflow feature-to-pr",
    });
    expect(s.git.pushedBranches).toEqual([out.branch]);
    const written = readFileSync(
      join(s.workspaces, out.branch.replace(/\//g, "-"), ".factory/workflows/feature-to-pr.yml"),
      "utf8",
    );
    const parsed = parseWorkflowText(written);
    if (!parsed.ok) throw new Error(parsed.problems.join("; "));
    expect(parsed.workflow.steps.build).toMatchObject({ agent: "codex", timeoutMinutes: 45 });
    expect(readFileSync(own, "utf8")).toBe(before);

    const bad = await s.call("POST", "/api/workflow-edit", {
      name: "feature-to-pr",
      form: { build: { colour: "red" } },
    });
    expect(bad.status).toBe(422);
    // An editable field with a value the watcher would refuse: an agent step does not retry.
    const invalid = await s.call("POST", "/api/workflow-edit", {
      name: "feature-to-pr",
      form: { build: { retries: 2 } },
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: string }).error).toContain("an agent step's retry is a reject");
    expect(s.github.createdPrs).toHaveLength(1);
  });
});
