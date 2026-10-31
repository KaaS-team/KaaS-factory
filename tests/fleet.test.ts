// The fleet on the Settings page: each machine's tags, slots in use, last heartbeat and current issues,
// written by the watcher's own poll, and each runtime the repo uses probed and cached.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { MachineLeases, MachineSpend } from "../src/machine";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import type { DashboardProject } from "../dashboard/project";
import { createDashboard } from "../dashboard/server";
import { machinesPanel, healthText, slotsText } from "../dashboard/public/lib/settings.js";
import { FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

type El = { t: string; c: (El | string)[] };
const h = (t: string, _a: unknown, ...c: unknown[]): El => ({ t, c: c.flat().filter((k) => k != null) as El["c"] });
const text = (e: El | string): string => (typeof e === "string" ? e : e.c.map(text).join(" "));

function setup(probe: DashboardProject["probe"]) {
  const dir = mkdtempSync(join(tmpdir(), "factory-fleet-"));
  const leases = new MachineLeases(join(dir, "machine.db"));
  const project: DashboardProject = {
    cloneDir: dir,
    config: { ...DEFAULT_CONFIG, runtime: { gates: "box" } },
    machine: { slots: 3, runtimes: { box: { kind: "ssh", host: "build-1", dir: "/w" } } },
    leases: async () => [],
    fleet: leases,
    probe,
  };
  const dashboard = createDashboard(
    new FactoryState(":memory:"),
    new FakeGitHub([]),
    "acme/widgets",
    false,
    dir,
    undefined,
    undefined,
    project,
  );
  const settings = async () =>
    (await (await dashboard.handle(new Request("http://localhost:4100/api/settings"), "127.0.0.1")).json()) as {
      slots: number;
      slotsInUse: number;
      machines: { name: string; tags: string[]; slots: number; used: number; tasks: string[]; stale: boolean }[];
      health: Record<string, { ok: boolean; ms: number; detail: string }>;
    };
  return { dir, leases, settings };
}

describe("fleet view", () => {
  test("every machine, its tags, slots in use, last heartbeat and current task, in one view", async () => {
    const { dir, leases, settings } = setup(async () => ({ ok: true, ms: 1, detail: "ok" }));
    leases.acquire("acme/widgets#4", { repo: "acme/widgets", repoCap: 2, machineSlots: 2 });
    leases.beat({ name: "ci-runner", tags: [], slots: 1, used: 0, tasks: [] }, Date.now() - 10 * 60_000);
    // A poll is the heartbeat: the watcher writes this machine's row before it lists any issue.
    await pollOnce(
      {
        github: new FakeGitHub([]),
        git: new FakeGit(),
        state: new FactoryState(":memory:"),
        executor: undefined as never,
        gateRunner: new FakeGateRunner(),
        holdoutRunner: new FakeHoldoutRunner(),
        cloneDir: dir,
        workspacesDir: dir,
        machine: {
          leases,
          config: { slots: 2, capabilities: ["gpu"] },
          spend: new MachineSpend(join(dir, "machine.db")),
        },
      },
      mergeConfig({ repo: "acme/widgets" }),
    );
    const body = await settings();
    const byName = Object.fromEntries(body.machines.map((m) => [m.name, m]));
    expect(body.machines).toHaveLength(2);
    expect(byName["ci-runner"]).toMatchObject({ tags: [], slots: 1, used: 0, tasks: [], stale: true });
    expect(byName[hostname()]).toMatchObject({
      tags: ["gpu"],
      slots: 2,
      used: 1,
      tasks: ["acme/widgets#4"],
      stale: false,
    });
    const page = text(machinesPanel(body, h));
    expect(page).toContain("1 of 2");
    expect(page).toContain("acme/widgets#4");
    expect(page).toContain("gone quiet");
    expect(text(machinesPanel({ machines: [] }, h))).toContain("No machine has reported yet");
  });

  test("the Settings page says how many slots are in use and whether each runtime the repo uses answers", async () => {
    let probes = 0;
    const { leases, settings } = setup(async (name) => {
      probes++;
      return { ok: false, ms: 9, detail: `${name}: connection refused` };
    });
    expect((await settings()).slotsInUse).toBe(0);
    const id = leases.acquire("acme/widgets#7", { repo: "acme/widgets", repoCap: 3, machineSlots: 3 })!;
    const body = await settings();
    expect(body.slotsInUse).toBe(1);
    expect(slotsText(body)).toBe("1 of 3 in use");
    // Only `box` is named by the repo (runtime.gates), and its probe is cached across requests.
    expect(body.health).toEqual({ box: { ok: false, ms: 9, detail: "box: connection refused" } });
    expect(probes).toBe(1);
    expect(healthText(body.health.box)).toEqual({ text: "Down: box: connection refused", tone: "bad" });
    expect(healthText(undefined).text).toBe("Not probed");
    leases.release(id);
    expect((await settings()).slotsInUse).toBe(0);
  });
});
