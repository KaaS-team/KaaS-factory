// A fresh worktree has no dependencies installed; ensureSetup runs
// config.setup once and never again, and a failing command stops the list
// and reports its output instead of silently continuing.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSetup, type SetupRunner } from "../src/setup";

class FakeSetupRunner implements SetupRunner {
  calls: string[] = [];
  failOn?: string;

  async run(cmd: string, _cwd: string) {
    this.calls.push(cmd);
    if (cmd === this.failOn) return { stdout: "", stderr: "npm ERR! no lockfile", code: 1 };
    return { stdout: `ran ${cmd}`, stderr: "", code: 0 };
  }
}

function tmpWorktree(): string {
  return mkdtempSync(join(tmpdir(), "factory-setup-"));
}

describe("ensureSetup", () => {
  test("no commands: a no-op that never calls the runner", async () => {
    const runner = new FakeSetupRunner();
    const result = await ensureSetup(runner, tmpWorktree(), []);
    expect(result).toEqual({ ok: true, ran: false, log: "" });
    expect(runner.calls).toEqual([]);
  });

  test("runs every command in order and writes the marker", async () => {
    const dir = tmpWorktree();
    const runner = new FakeSetupRunner();
    const result = await ensureSetup(runner, dir, ["npm ci", "npm run build"]);
    expect(result.ok).toBe(true);
    expect(result.ran).toBe(true);
    expect(result.log).toContain("ran npm ci");
    expect(runner.calls).toEqual(["npm ci", "npm run build"]);
    expect(await Bun.file(join(dir, ".factory/runs/setup.done")).exists()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a second call on the same worktree does not re-run the commands", async () => {
    const dir = tmpWorktree();
    const runner = new FakeSetupRunner();
    await ensureSetup(runner, dir, ["npm ci"]);
    const second = await ensureSetup(runner, dir, ["npm ci"]);
    expect(second).toEqual({ ok: true, ran: false, log: "" });
    expect(runner.calls).toEqual(["npm ci"]); // only the first call ran it
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failing command stops the list, reports its output, and never writes the marker", async () => {
    const dir = tmpWorktree();
    const runner = new FakeSetupRunner();
    runner.failOn = "npm ci";
    const result = await ensureSetup(runner, dir, ["npm ci", "npm run build"]);
    expect(result.ok).toBe(false);
    expect(result.ran).toBe(true);
    expect(result.log).toContain("npm ERR! no lockfile");
    expect(runner.calls).toEqual(["npm ci"]); // the second command never ran
    expect(await Bun.file(join(dir, ".factory/runs/setup.done")).exists()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
