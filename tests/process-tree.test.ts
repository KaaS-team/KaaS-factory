import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordChildren, release, survivorLine, terminate, trackStep } from "../src/process-tree";

// Forks two sleepers, one of them in its own session, and writes their pids.
const FIXTURE = (pids: string) =>
  `sleep 60 & echo $! >> ${pids}; setsid sleep 60 & echo $! >> ${pids}; sleep 0.1; wait`;

function isAlive(pid: number): boolean {
  const out = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="])
    .stdout.toString()
    .trim();
  return out !== "" && !out.startsWith("Z");
}

async function started(file: string, count = 2): Promise<number[]> {
  for (let i = 0; i < 200; i++) {
    const pids = (() => {
      try {
        return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number);
      } catch {
        return [];
      }
    })();
    if (pids.length === count) return pids;
    await Bun.sleep(25);
  }
  throw new Error("fixture did not start");
}

function fixtureStep(dir: string) {
  const pids = join(dir, "pids");
  writeFileSync(pids, "");
  const proc = Bun.spawn(["bash", "-c", FIXTURE(pids)], { detached: true, stdout: "ignore", stderr: "ignore" });
  return { proc, pids };
}

describe("terminate", () => {
  test("cancelling a step that forks two children leaves none", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "ptree-"));
    const { proc, pids } = fixtureStep(dir);
    try {
      const kids = await started(pids);
      trackStep("a", proc.pid);
      expect(recordChildren("a")).toEqual(expect.arrayContaining(kids));
      const report = await terminate("a", 200);
      expect(report.survivors).toEqual([]);
      expect(report.ended).toEqual(expect.arrayContaining([proc.pid, ...kids]));
      for (const pid of kids) expect(isAlive(pid)).toBe(false);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a released child outlives the step and is not reported", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "ptree-"));
    const { proc, pids } = fixtureStep(dir);
    let kept = 0;
    try {
      const kids = await started(pids);
      kept = kids[1]!;
      trackStep("b", proc.pid);
      recordChildren("b");
      release("b", kept);
      const report = await terminate("b", 200);
      expect(report.survivors).toEqual([]);
      expect(isAlive(kept)).toBe(true);
      expect(isAlive(kids[0]!)).toBe(false);
    } finally {
      if (kept) process.kill(kept, "SIGKILL");
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a child that ignores TERM is escalated and ended", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "ptree-"));
    const pids = join(dir, "pids");
    const proc = Bun.spawn(["bash", "-c", `(trap '' TERM; sleep 60) & echo $! > ${pids}; wait`], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const [kid] = await started(pids, 1);
      trackStep("c", proc.pid);
      const report = await terminate("c", 100);
      expect(report.survivors).toEqual([]);
      expect(isAlive(kid!)).toBe(false);
    } finally {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("survivorLine", () => {
  test("names every survivor, and is silent when none", () => {
    expect(survivorLine({ ended: [1], survivors: [7, 9] })).toBe("still running after cancel: pid 7, 9");
    expect(survivorLine({ ended: [1], survivors: [] })).toEqual(undefined);
  });
});
