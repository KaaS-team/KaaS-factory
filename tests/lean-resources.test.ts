// Lean on resources: the CLI and the dashboard each start in a small fraction of a 1 GB box, and the
// default sandbox asks for one CPU and 1 GB, so a laptop runs several issues at once.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_VM } from "../src/runtimes";

const MB = 1024 * 1024;
const root = join(import.meta.dir, "..");

function start(argv: string[]) {
  const t = performance.now();
  const r = Bun.spawnSync([process.execPath, ...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, rss: r.resourceUsage.maxRSS, ms: performance.now() - t };
}

describe("lean resources", () => {
  test("the CLI and the dashboard start under 100 MB, and the default sandbox is one CPU and 1 GB", () => {
    for (const argv of [
      ["bin/factory", "--help"],
      ["-e", 'await import("./dashboard/server.ts")'],
    ]) {
      const r = start(argv);
      expect(r.ok).toBe(true);
      expect(r.rss).toBeLessThan(100 * MB);
      expect(r.ms).toBeLessThan(5_000);
    }
    expect({ memory: DEFAULT_VM.memory, cpus: DEFAULT_VM.cpus }).toEqual({ memory: "1G", cpus: 1 });
  });
});
