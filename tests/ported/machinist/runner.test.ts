// Ported from owainlewis/machinist@3943516 internal/runner/runner_test.go:162-260,579-610 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the process_unix_test.go group-kill cases are folded in; cases run a shell script through CommandExecutor; the Go run-store, cancellation and darwin-EPERM cases are not ported (there is no run store, and Bun's kill of a negative pid surfaces ESRCH as an exception that the executor already swallows).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../../../src/agents/executor";
import { sanitizeEnv } from "../../../src/agents/env";
import { stageSchema } from "../../../src/schemas";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-runner-")));
  roots.push(dir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".claude/skills/factory-plan"), { recursive: true });
  writeFileSync(join(dir, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
  return dir;
}

const run = (cwd: string, script: string, extra: Record<string, unknown> = {}) =>
  new CommandExecutor({ a: { command: ["sh", "-c", script, "agent"] } }, { default: "a" }).runStage({
    stage: "plan",
    issue: 7,
    cwd,
    maxBudgetUsd: 1,
    ...extra,
  });

describe("environment", () => {
  test("the agent gets the factory's directories and none of the runner's secrets", async () => {
    const cwd = repo();
    const before = { gh: process.env.GH_TOKEN, fac: process.env.FACTORY_DASHBOARD_TOKEN };
    process.env.GH_TOKEN = "secret";
    process.env.FACTORY_DASHBOARD_TOKEN = "secret";
    try {
      await run(
        cwd,
        'cat >/dev/null; printf "%s\\n" "$FACTORY_STAGE" "$FACTORY_ISSUE" "$FACTORY_ARTIFACT_DIR" "${GH_TOKEN:-none}" "${FACTORY_DASHBOARD_TOKEN:-none}" "$FACTORY_SCRATCH_DIR" > "$FACTORY_ARTIFACT_DIR/env.txt"',
      );
    } finally {
      if (before.gh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = before.gh;
      if (before.fac === undefined) delete process.env.FACTORY_DASHBOARD_TOKEN;
      else process.env.FACTORY_DASHBOARD_TOKEN = before.fac;
    }
    const [stage, issue, dir, gh, dash, scratch] = readFileSync(join(cwd, ".factory/runs/issue-7/env.txt"), "utf8")
      .trim()
      .split("\n");
    expect([stage, issue, dir, gh, dash]).toEqual(["plan", "7", join(cwd, ".factory/runs/issue-7"), "none", "none"]);
    expect(scratch).toContain("factory-scratch-7-");
    expect(existsSync(scratch!)).toBe(false); // removed when the stage ends
  });

  test("the stage's schema is in the scratch dir for the stop-artifact hook", async () => {
    const cwd = repo();
    await run(cwd, 'cat >/dev/null; cp "$FACTORY_SCRATCH_DIR/artifact.schema.json" "$FACTORY_ARTIFACT_DIR/"');
    const spec = JSON.parse(readFileSync(join(cwd, ".factory/runs/issue-7/artifact.schema.json"), "utf8"));
    expect(spec).toEqual({ file: "plan.json", schema: stageSchema("plan"), stoppedOwesOnlyOutcome: false });
  });

  test("an inherited GIT_DIR or GIT_WORK_TREE does not redirect the agent's git", async () => {
    const requested = repo();
    const other = repo();
    const before = { d: process.env.GIT_DIR, w: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    try {
      await run(requested, 'cat >/dev/null; git rev-parse --show-toplevel > "$FACTORY_ARTIFACT_DIR/top.txt"');
    } finally {
      if (before.d === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before.d;
      if (before.w === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = before.w;
    }
    expect(readFileSync(join(requested, ".factory/runs/issue-7/top.txt"), "utf8").trim()).toBe(requested);
  });

  test("sanitizeEnv drops repository git variables but keeps identity and PATH", () => {
    const clean = sanitizeEnv({
      PATH: "/bin",
      GIT_DIR: "x",
      GIT_INDEX_FILE: "y",
      GIT_CONFIG_KEY_0: "k",
      GIT_AUTHOR_NAME: "a",
      ANTHROPIC_API_KEY: "k",
    });
    expect(Object.keys(clean).sort()).toEqual(["ANTHROPIC_API_KEY", "GIT_AUTHOR_NAME", "PATH"]);
  });
});

describe("process group", () => {
  test("a timeout kills the agent and its children, and the stage still finishes", async () => {
    const cwd = repo();
    const marker = join(cwd, "child.pid");
    const started = Date.now();
    const result = await run(cwd, `cat >/dev/null; sleep 30 & echo $! > ${marker}; wait`, { timeoutMinutes: 0.03 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.killedReason).toContain("stageTimeoutMinutes");
    expect(result.exitCode).not.toBe(0);
    const pid = Number(readFileSync(marker, "utf8"));
    // SIGKILL lands asynchronously; under load the grandchild can outlive the stage by a few ms.
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 2_000; waited += 50) await Bun.sleep(50);
    expect(alive()).toBe(false); // the grandchild is gone
  });

  test("a descendant that keeps the output pipe open does not hang a finished stage", async () => {
    const cwd = repo();
    const started = Date.now();
    const result = await run(cwd, "cat >/dev/null; (sleep 30 >/dev/null 2>&1 &) ; exit 0");
    expect(result.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

test("a command that cannot start is a failed stage with the reason, not a crash", async () => {
  const cwd = repo();
  const result = await new CommandExecutor({ a: { command: [join(cwd, "not-an-agent")] } }, { default: "a" })
    .runStage({ stage: "plan", issue: 7, cwd, maxBudgetUsd: 1 })
    .catch((e: Error) => e);
  expect(result instanceof Error ? result.message : `exit ${result.exitCode}`).toMatch(
    /not-an-agent|ENOENT|exit [1-9]/,
  );
});
