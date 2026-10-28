// The fleet and runtime health on the Settings page: every machine that beats into this FACTORY_HOME,
// and whether each runtime this repo uses answers. Probes are cached, so a page refresh never boots a VM.

import { plain } from "../src/display";
import type { MachineBeat } from "../src/machine";
import { type Health, probeNamed } from "../src/runtime-kit";
import type { DashboardProject } from "./project";

// Two missed polls at the slowest default interval: a machine this quiet has stopped or lost its disk.
export const STALE_MS = 120_000;
const HEALTH_TTL_MS = 5 * 60_000;

export function fleetView(machines: readonly (MachineBeat & { heartbeatAt: number })[], now: number) {
  return machines.map((m) => ({
    name: plain(m.name),
    tags: m.tags.map(plain),
    slots: m.slots,
    used: m.used,
    tasks: m.tasks.map(plain),
    heartbeatAt: m.heartbeatAt,
    stale: now - m.heartbeatAt > STALE_MS,
  }));
}

// Only runtimes something in the repo names are probed: an unused ssh box is never dialled.
export function healthCache(clock: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<Health> }>();
  return async (project: DashboardProject, runtimes: readonly { name: string; usedBy: readonly string[] }[]) => {
    const probe = project.probe ?? ((name: string) => probeNamed(project.machine.runtimes, name, 10_000));
    const used = runtimes.filter((r) => r.usedBy.length).map((r) => r.name);
    const entries = await Promise.all(
      used.map(async (name) => {
        let hit = cache.get(name);
        if (!hit || clock() - hit.at > HEALTH_TTL_MS) cache.set(name, (hit = { at: clock(), value: probe(name) }));
        const h = await hit.value;
        return [name, { ok: h.ok, ms: h.ms, detail: plain(h.detail) }] as const;
      }),
    );
    return Object.fromEntries(entries);
  };
}
