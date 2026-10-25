// FACTORY_PORT: two worktrees of one clone, as the factory makes them, never
// get the same port, and each keeps its port across stages and gates.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreePort } from "../src/port";
import { ShellGateRunner } from "../src/gates";
import { CommandExecutor } from "../src/agents/executor";
import type { ExecutionPort } from "../src/ports/execution";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe" });

// A clone with two linked worktrees, like the factory's per-issue ones.
function clone(): { main: string; a: string; b: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-port-")));
  roots.push(root);
  const main = join(root, "clone");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "base");
  for (const name of ["a", "b"]) git(main, "worktree", "add", "-q", "-b", `issue-${name}`, join(root, name));
  return { main, a: join(root, "a"), b: join(root, "b") };
}

describe("worktreePort", () => {
  test("each worktree gets its own port, and keeps it", () => {
    const { a, b } = clone();
    const pa = worktreePort(a)!;
    expect(pa).toBeGreaterThan(0);
    expect(worktreePort(b)).not.toBe(pa);
    expect(worktreePort(a)).toBe(pa);
  });

  test("a port another worktree holds is never handed out again, even when the OS offers it", () => {
    const { a, b } = clone();
    const offers = [5001, 5001, 5002];
    expect(worktreePort(a, () => offers.shift()!)).toBe(5001);
    expect(worktreePort(b, () => offers.shift()!)).toBe(5002);
  });

  test("the port lives in git's own dir, so it never shows up in the diff", () => {
    const { a } = clone();
    worktreePort(a);
    expect(git(a, "status", "--porcelain").stdout.toString()).toBe("");
  });

  test("outside a git checkout there is no port", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-port-none-"));
    roots.push(dir);
    expect(worktreePort(dir)).toBeUndefined();
  });
});

describe("FACTORY_PORT reaches the stage and the gates", () => {
  test("gates.sh runs with the worktree's port", async () => {
    const { a } = clone();
    const cmds: string[] = [];
    const exec: ExecutionPort = { run: async (cmd) => (cmds.push(cmd), { stdout: "", stderr: "", code: 0 }) };
    await new ShellGateRunner(exec).run(a);
    expect(cmds).toEqual([`FACTORY_PORT=${worktreePort(a)} bash .factory/gates.sh`]);
  });

  test("the agent's environment carries the same port", async () => {
    const { a } = clone();
    mkdirSync(join(a, ".claude/skills/factory-plan"), { recursive: true });
    writeFileSync(join(a, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
    const executor = new CommandExecutor(
      {
        x: {
          command: ["sh", "-c", 'cat >/dev/null; echo "$FACTORY_PORT" > "$FACTORY_ARTIFACT_DIR/port.txt"', "agent"],
        },
      },
      { default: "x" },
    );
    await executor.runStage({ stage: "plan", issue: 7, cwd: a, maxBudgetUsd: 1 });
    expect(Number(readFileSync(join(a, ".factory/runs/issue-7/port.txt"), "utf8"))).toBe(worktreePort(a)!);
  });
});
