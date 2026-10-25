// Ported from owainlewis/assembler@7cac671 test/runtime.test.ts:9-33 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the harnessInput and execute cases run through CommandExecutor and its {{prompt}} placeholder instead of assembler's `{prompt}`; the workflow, fix-checks, config and CLI cases are not ported (no workflow engine here); cancellation is not ported (a stage has a timeout, not an abort signal).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../../../src/agents/executor";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-runtime-")));
  roots.push(dir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".claude/skills/factory-plan"), { recursive: true });
  writeFileSync(
    join(dir, ".claude/skills/factory-plan/SKILL.md"),
    '---\nname: factory-plan\n---\nPLAN-BODY `touch bad` $(echo bad) "quotes"\nline\n',
  );
  return dir;
}

const run = (cwd: string, command: string[], extra: Record<string, unknown> = {}) =>
  new CommandExecutor({ a: { command } }, { default: "a" }).runStage({
    stage: "plan",
    issue: 7,
    cwd,
    maxBudgetUsd: 1,
    ...extra,
  });

test("prompts remain literal arguments, including shell syntax", async () => {
  const cwd = repo();
  await run(cwd, ["sh", "-c", 'printf %s "$1" > "$FACTORY_ARTIFACT_DIR/arg.txt"', "agent", "{{prompt}}"]);
  const arg = readFileSync(join(cwd, ".factory/runs/issue-7/arg.txt"), "utf8");
  expect(arg).toContain('PLAN-BODY `touch bad` $(echo bad) "quotes"\nline');
  expect(Bun.spawnSync(["test", "-e", join(cwd, "bad")]).exitCode).not.toBe(0);
});

test("stdin, stderr and nonzero exit are preserved", async () => {
  const cwd = repo();
  const result = await run(cwd, ["sh", "-c", 'cat > "$FACTORY_ARTIFACT_DIR/in.txt"; echo failure >&2; exit 7']);
  expect(result.exitCode).toBe(7);
  expect(result.stderrTail).toContain("failure");
  expect(readFileSync(join(cwd, ".factory/runs/issue-7/in.txt"), "utf8")).toContain("PLAN-BODY");
});

test("hung processes time out", async () => {
  const result = await run(repo(), ["sh", "-c", "cat >/dev/null; sleep 30"], { timeoutMinutes: 0.01 });
  expect(result.killedReason).toContain("exceeded");
  expect(result.exitCode).not.toBe(0);
});
