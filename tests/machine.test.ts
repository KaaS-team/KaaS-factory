// Machine-wide slot leases (plan v2.7.0 item 5): two watcher processes on one
// machine must never together hold more leases than the machine's own slot
// count, whatever the mix of job lengths. Simulated here as two independent
// MachineLeases instances pointed at the same on-disk db, which is exactly
// what two real `factory watch` processes sharing FACTORY_HOME would be.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentVm, escapeLike, loadMachineConfig, MachineLeases, suggestSlots } from "../src/machine";

const cap = (n: number) => ({ repo: "r", repoCap: n, machineSlots: n });

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-machine-"));
  return join(dir, "machine.db");
}

describe("MachineLeases", () => {
  test("a slot can be acquired and released", () => {
    const leases = new MachineLeases(tmpDb());
    const id = leases.acquire("r#a", cap(2));
    expect(id).not.toBeUndefined();
    expect(leases.held()).toBe(1);
    leases.release(id!);
    expect(leases.held()).toBe(0);
    leases.close();
  });

  test("acquiring past the slot count returns undefined, never oversubscribes", () => {
    const leases = new MachineLeases(tmpDb());
    const a = leases.acquire("r#a", cap(1));
    const b = leases.acquire("r#b", cap(1));
    expect(a).not.toBeUndefined();
    expect(b).toBeUndefined();
    expect(leases.held()).toBe(1);
    leases.close();
  });

  test("a lease held by a dead pid is reclaimed on the next acquire", () => {
    const leases = new MachineLeases(tmpDb());
    // A pid this high is never a real running process.
    const dead = leases.acquire("r#a", cap(1), 999_999_999);
    expect(dead).not.toBeUndefined();
    const next = leases.acquire("r#b", cap(1));
    expect(next).not.toBeUndefined();
    expect(leases.held()).toBe(1);
    leases.close();
  });

  // Property: whatever the mix of job lengths (random delays here), the
  // number of simultaneously-held leases across two independent leaseholders
  // sharing one db file never exceeds the machine's own slot count.
  test("across two processes sharing one db, held leases never exceed the slot count", async () => {
    const path = tmpDb();
    const slots = 3;
    const procA = new MachineLeases(path);
    const procB = new MachineLeases(path);
    let maxHeld = 0;
    const observedSlots: string[] = [];

    async function job(leases: MachineLeases, holder: string): Promise<void> {
      for (let i = 0; i < 8; i++) {
        let id: number | undefined;
        for (;;) {
          id = leases.acquire(`r#${holder}`, cap(slots));
          if (id !== undefined) break;
          await Bun.sleep(1);
        }
        observedSlots.push(holder);
        maxHeld = Math.max(maxHeld, Math.max(procA.held(), procB.held()));
        // Re-check the true global count (both processes' leases are in the
        // same table), not just this instance's local view.
        const global = procA.held();
        maxHeld = Math.max(maxHeld, global);
        expect(global).toBeLessThanOrEqual(slots);
        await Bun.sleep(Math.random() * 5);
        leases.release(id);
      }
    }

    await Promise.all([job(procA, "A"), job(procB, "B")]);
    expect(observedSlots.length).toBe(16);
    expect(procA.held()).toBe(0);
    procA.close();
    procB.close();
  });
});

describe("per-repo cap", () => {
  const of = (repo: string) => ({ repo, repoCap: 2, machineSlots: 4 });

  test("a repo at its repoCap waits while another repo still gets a machine slot", () => {
    const leases = new MachineLeases(tmpDb());
    const a1 = leases.acquire("acme/a#1", of("acme/a"));
    expect(leases.acquire("acme/a#2", of("acme/a"))).not.toBeUndefined();
    expect(leases.acquire("acme/b#1", of("acme/b"))).not.toBeUndefined();
    expect(leases.acquire("acme/a#3", of("acme/a"))).toBeUndefined();
    expect(leases.acquire("acme/b#2", of("acme/b"))).not.toBeUndefined();
    leases.release(a1!);
    expect(leases.acquire("acme/a#3", of("acme/a"))).not.toBeUndefined();
    leases.close();
  });

  test("the repo count escapes LIKE wildcards in the repo name", () => {
    expect(escapeLike("a_b%c\\d")).toBe("a\\_b\\%c\\\\d");
    const leases = new MachineLeases(tmpDb());
    expect(leases.acquire("acme/aXb#1", of("acme/aXb"))).not.toBeUndefined();
    expect(leases.acquire("acme/a_b#1", of("acme/a_b"))).not.toBeUndefined();
    expect(leases.acquire("acme/a_b#2", of("acme/a_b"))).not.toBeUndefined();
    expect(leases.acquire("acme/a_b#3", of("acme/a_b"))).toBeUndefined();
    leases.close();

    const wild = new MachineLeases(tmpDb());
    wild.acquire("acme/ab#1", of("acme/ab"));
    wild.acquire("acme/ab#2", of("acme/ab"));
    expect(wild.acquire("acme/a%#1", of("acme/a%"))).not.toBeUndefined();
    wild.close();
  });
});

describe("loadMachineConfig", () => {
  test("FACTORY_SLOTS wins over machine.json and must be a positive integer", () => {
    expect(loadMachineConfig({ FACTORY_SLOTS: "4", HOME: "/nonexistent" })).toEqual({ slots: 4 });
    expect(() => loadMachineConfig({ FACTORY_SLOTS: "0", HOME: "/nonexistent" })).toThrow(/positive integer/);
    expect(() => loadMachineConfig({ FACTORY_SLOTS: "abc", HOME: "/nonexistent" })).toThrow(/positive integer/);
  });

  test("naming neither falls back to the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-home-"));
    expect(loadMachineConfig({ FACTORY_HOME: dir })).toEqual({ slots: 2 });
    rmSync(dir, { recursive: true, force: true });
  });

  test("machine.json is read and validated when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-home-"));
    Bun.write(`${dir}/machine.json`, JSON.stringify({ slots: 3, dailyUsd: 20 }));
    expect(loadMachineConfig({ FACTORY_HOME: dir })).toEqual({ slots: 3, dailyUsd: 20 });
    Bun.write(`${dir}/machine.json`, JSON.stringify({ slots: 0 }));
    expect(() => loadMachineConfig({ FACTORY_HOME: dir })).toThrow(/positive integer/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("agentRuntime", () => {
  const vm = { kind: "microsandbox", image: "node:22-slim", allow: ["api.anthropic.com"] } as const;
  const home = (machine: object) => {
    const dir = mkdtempSync(join(tmpdir(), "factory-home-"));
    writeFileSync(`${dir}/machine.json`, JSON.stringify(machine));
    return dir;
  };

  test("names the microsandbox runtime every agent runs in, and FACTORY_SLOTS keeps it", () => {
    const dir = home({ slots: 2, runtimes: { vm }, agentRuntime: "vm" });
    expect(agentVm(loadMachineConfig({ FACTORY_HOME: dir }))).toEqual(vm);
    const withSlots = loadMachineConfig({ FACTORY_HOME: dir, FACTORY_SLOTS: "5" });
    expect(withSlots.slots).toBe(5);
    expect(agentVm(withSlots)).toEqual(vm);
    expect(agentVm({ slots: 1 })).toBeUndefined();
  });

  test("anything but a microsandbox or docker runtime in the same file refuses to start", () => {
    for (const bad of [
      { slots: 1, agentRuntime: "vm" },
      { slots: 1, runtimes: { vm: { kind: "ssh", host: "h", dir: "/w" } }, agentRuntime: "vm" },
      { slots: 1, runtimes: { vm }, agentRuntime: "local" },
    ])
      expect(() => loadMachineConfig({ FACTORY_HOME: home(bad) })).toThrow(
        /"agentRuntime" must name a microsandbox or docker runtime/,
      );
  });
});

describe("suggestSlots", () => {
  test("is a positive integer", () => {
    expect(Number.isInteger(suggestSlots())).toBe(true);
    expect(suggestSlots()).toBeGreaterThanOrEqual(1);
  });
});
