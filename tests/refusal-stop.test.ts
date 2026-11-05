// #639: a stage stops after a set number of refused tool calls and names the refused commands.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { parseStreamJsonLine } from "../src/agents/presets/claude";
import { DEFAULT_MAX_REFUSALS, parseWorkflow } from "../src/core/workflow";
import { refusalStop, type StageEvent } from "../src/executor";

const call = (id: string, command: string): StageEvent => ({
  kind: "tool_use",
  toolName: "Bash",
  toolTarget: command,
  toolUseId: id,
});
const refusal = (id: string, by = "allowlist"): StageEvent => ({ kind: "refusal", toolUseId: id, refusedBy: by });
const refusedRun = (n: number): StageEvent[] =>
  Array.from({ length: n }, (_, i) => [call(`t${i}`, `curl http://x/${i}`), refusal(`t${i}`)]).flat();

describe("refusalStop", () => {
  test("stops at the limit and lists every refused command", () => {
    const why = refusalStop(refusedRun(5), 5);
    expect(why).toContain("stopped after 5 refused tool calls (limit 5)");
    for (let i = 0; i < 5; i++) expect(why).toContain(`Bash curl http://x/${i}`);
  });

  test("does not stop below the limit", () => {
    expect(refusalStop(refusedRun(4), 5)).toBe(undefined);
  });

  test("calls that were allowed do not count", () => {
    const allowed = Array.from({ length: 9 }, (_, i) => call(`a${i}`, "ls"));
    expect(refusalStop([...allowed, ...refusedRun(2)], 3)).toBe(undefined);
  });

  test("a refusal with no matching call is still named by its tool and what refused it", () => {
    expect(refusalStop([refusal("zz", "hook:guard")], 1)).toContain("`tool` (hook:guard)");
  });
});

describe("workflow limits.refusals", () => {
  const steps = { steps: { s: { uses: "x", label: "l" } } };
  const kinds = { x: { terminal: true } };
  const limitsOf = (limits?: unknown) => {
    const r = parseWorkflow({ name: "w", ...(limits === undefined ? {} : { limits }), ...steps }, kinds);
    return r.ok ? r.workflow.limits.refusals : r.problems;
  };

  test("defaults to 5", () => {
    expect(DEFAULT_MAX_REFUSALS).toBe(5);
    expect(limitsOf()).toBe(5);
  });
  test("is set per workflow", () => expect(limitsOf({ refusals: 2 })).toBe(2));
  test("must be a whole number of at least 1", () => {
    expect(limitsOf({ refusals: 0 })).toEqual(["limits.refusals: must be a whole number, 1 or more"]);
    expect(limitsOf({ refusals: 1.5 })).toHaveLength(1);
  });
});

describe("claude parser", () => {
  test("a tool_use event carries the call's id, so a refusal can be matched to it", () => {
    const [e] = parseStreamJsonLine(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] },
      }),
    );
    expect(e).toEqual({ kind: "tool_use", toolName: "Bash", toolTarget: "ls", toolUseId: "tu_1" });
  });
});

describe("CommandExecutor", () => {
  const dirs: string[] = [];
  const oldPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // A fake `claude` that refuses n calls in a row and then hangs, so only a stop ends it early.
  async function run(refused: number, maxRefusals: number) {
    mkdirSync(tmpdir(), { recursive: true });
    const d = mkdtempSync(join(tmpdir(), "refusal-stop-"));
    dirs.push(d);
    mkdirSync(join(d, "bin"));
    const lines = Array.from({ length: refused }, (_, i) => [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command: `curl http://x/${i}` } }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: `t${i}`,
              is_error: true,
              content: "Permission to use Bash has been denied.",
            },
          ],
        },
      },
    ]).flat();
    writeFileSync(join(d, "lines"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    writeFileSync(join(d, "bin", "claude"), `#!/bin/sh\ncat >/dev/null\ncat "${join(d, "lines")}"\nsleep 3\n`);
    chmodSync(join(d, "bin", "claude"), 0o755);
    process.env.PATH = `${join(d, "bin")}:${oldPath}`;
    const ex = new CommandExecutor({ claude: { preset: "claude" } }, { default: "claude" });
    return ex.runStage({
      stage: "triage",
      issue: 1,
      cwd: d,
      maxBudgetUsd: 1,
      timeoutMinutes: 1,
      maxRefusals,
    });
  }

  test("kills the stage at the limit and lists the refused commands", async () => {
    const t0 = Date.now();
    const r = await run(3, 3);
    expect(r.killedReason).toContain("stopped after 3 refused tool calls (limit 3)");
    expect(r.killedReason).toContain("curl http://x/2");
    expect(Date.now() - t0).toBeLessThan(2900);
  });

  test("lets the stage run on below the limit", async () => {
    const r = await run(2, 3);
    expect(r.killedReason).toBe(undefined);
  });
});
