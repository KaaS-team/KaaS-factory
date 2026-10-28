// The lease rule and the heartbeat. The adapters' compare-and-swap is the
// contract in tests/ports/lease.contract.ts, run against a real bare repo.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitLeases } from "../src/adapters/git-lease/lease";
import { decodeLease, encodeLease, mayTake } from "../src/core/lease";
import { withLease } from "../src/engine/lease";
import { FakeLeases } from "./harness";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
}

describe("lease record", () => {
  test("free, own, or expired may be taken; another's live lease may not", () => {
    expect(mayTake(undefined, "a", 5)).toBe(true);
    expect(mayTake({ holder: "a", expiresAt: 10 }, "a", 5)).toBe(true);
    expect(mayTake({ holder: "b", expiresAt: 10 }, "a", 10)).toBe(true);
    expect(mayTake({ holder: "b", expiresAt: 10 }, "a", 9)).toBe(false);
  });
  test("round-trips, and anything unreadable is free", () => {
    expect(decodeLease(`${encodeLease({ holder: "h-1", expiresAt: 42 })}\n`)).toEqual({ holder: "h-1", expiresAt: 42 });
    expect(decodeLease("factory: claim")).toBeUndefined();
    expect(decodeLease('{"holder":1,"expiresAt":2}')).toBeUndefined();
  });
});

describe("withLease", () => {
  test("renews on the heartbeat while work runs, then releases", async () => {
    const port = new FakeLeases();
    expect(await withLease(port, "1", "me", async () => (await Bun.sleep(40), "done"), { everyMs: 5 })).toBe("done");
    expect(port.log.filter((l) => l === "acquire 1 me").length).toBeGreaterThanOrEqual(3);
    expect(port.log.at(-1)).toBe("release 1 me");
  });
  test("held elsewhere: work never runs", async () => {
    const port = new FakeLeases();
    await port.acquire("1", "other", 30_000, Date.now());
    let ran = false;
    expect(await withLease(port, "1", "me", async () => (ran = true))).toBeUndefined();
    expect(ran).toBe(false);
  });
  test("a failed renewal marks it lost, and a lost lease is not released", async () => {
    const port = new FakeLeases();
    const lost = await withLease(
      port,
      "1",
      "me",
      async (held) => {
        port.table.set("1", { holder: "other", expiresAt: Date.now() + 60_000 });
        await Bun.sleep(30);
        return held.lost;
      },
      { everyMs: 5 },
    );
    expect(lost).toBe(true);
    expect(port.log).not.toContain("release 1 me");
  });
});

describe("GitLeases through a failing pre-push hook", () => {
  test("acquire succeeds through a failing pre-push hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-lease-"));
    roots.push(root);
    const bare = join(root, "origin.git");
    mkdirSync(bare);
    await run(["git", "init", "--bare", "-b", "main", bare], root);
    const clone = join(root, "clone");
    await run(["git", "clone", bare, clone], root);
    writeFileSync(join(clone, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    expect(await new GitLeases(clone).acquire("1", "me", 60_000, Date.now())).toBe(true);
    const ls = Bun.spawnSync(["git", "ls-remote", bare, "refs/factory/lease/1"], { cwd: root });
    expect(ls.stdout.toString()).toContain("refs/factory/lease/1");
  });
});
