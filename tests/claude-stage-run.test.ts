// Claude stage runs against a fake `claude` on PATH.
// A stage that starts without the MCP servers or plugins it asked for is stopped at
// the init event, not left to run without them. The init shape (status "failed") was
// captured from claude 2.1.294 with an unstartable --mcp-config server.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor, renderEvent } from "../src/agents/executor";
import { parseStreamJsonLine } from "../src/agents/presets/claude";

const scratch = mkdtempSync(join(tmpdir(), "factory-startup-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const init = (extra: object) => JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", ...extra });

// A worktree with the build skill, and a fake claude on PATH running `body`.
async function runBuild(body: string) {
  const bin = mkdtempSync(join(scratch, "bin-"));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const cwd = mkdtempSync(join(scratch, "wt-"));
  mkdirSync(join(cwd, ".claude/skills/factory-build"), { recursive: true });
  writeFileSync(join(cwd, ".claude/skills/factory-build/SKILL.md"), "build it\n");
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const ex = new CommandExecutor({ claude: { preset: "claude" } }, { default: "claude" });
    return { cwd, result: await ex.runStage({ stage: "build", issue: 7, cwd, maxBudgetUsd: 1 }) };
  } finally {
    process.env.PATH = saved;
  }
}

describe("claude stage env", () => {
  test("background tasks and nonessential traffic are off", async () => {
    const { cwd } = await runBuild(`env > "$PWD/env.txt"`);
    const env = readFileSync(join(cwd, "env.txt"), "utf8");
    expect(env).toContain("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1");
    expect(env).toContain("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1");
  });
});

describe("claude init problems", () => {
  test("a failed MCP server and reported plugin errors become startup_error events", () => {
    const events = parseStreamJsonLine(
      init({
        mcp_servers: [
          { name: "ok", status: "connected" },
          { name: "bad", status: "failed" },
        ],
        plugin_errors: ["lwp-eng: manifest invalid"],
      }),
    );
    expect(events.filter((e) => e.kind === "startup_error").map((e) => e.text)).toEqual([
      "MCP server bad failed to start",
      "lwp-eng: manifest invalid",
    ]);
  });

  test("a clean init has none", () => {
    const events = parseStreamJsonLine(init({ mcp_servers: [{ name: "ok", status: "connected" }] }));
    expect(events.some((e) => e.kind === "startup_error")).toBe(false);
  });

  test("the executor kills the stage on the first startup_error instead of letting it run", async () => {
    const line = init({ mcp_servers: [{ name: "bad", status: "failed" }] });
    const started = Date.now();
    const { result } = await runBuild(`echo '${line}'\nsleep 30`);
    expect(result.killedReason).toBe("agent startup failed: MCP server bad failed to start");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("claude tool lines in the transcript", () => {
  const call = (name: string, input: object) =>
    parseStreamJsonLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }),
    );

  test("a watcher sees the file or command each call touched", () => {
    expect(renderEvent(call("Read", { file_path: "src/csv.ts" })[0]!)).toBe("> Read src/csv.ts");
    expect(renderEvent(call("Bash", { command: "make test\necho done", description: "run" })[0]!)).toBe(
      "> Bash make test",
    );
  });

  test("a path inside the worktree prints relative to it", () => {
    const cwd = "/home/op/.factory/o/r/workspaces/issue-7";
    expect(renderEvent(call("Read", { file_path: `${cwd}/src/csv.ts` })[0]!, cwd)).toBe("> Read src/csv.ts");
    expect(renderEvent(call("Bash", { command: `cat ${cwd}/a.ts ${cwd}/b.ts` })[0]!, cwd)).toBe("> Bash cat a.ts b.ts");
    const long = renderEvent(call("Bash", { command: `bun test ${"x".repeat(200)}` })[0]!, cwd)!;
    expect(long.length).toBe("> Bash ".length + 90);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a call with nothing to name keeps the bare line the e2e scorer counts", () => {
    expect(renderEvent(call("ScheduleWakeup", { delaySeconds: 60 })[0]!)).toBe("> ScheduleWakeup");
  });
});
