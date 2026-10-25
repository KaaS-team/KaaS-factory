// The live window: a real build stream renders its edit diff and its failing then
// passing test run, and the executor writes the stream that `factory view` follows.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CommandExecutor } from "../src/agents/executor";
import { streamPath, transcriptPath } from "../src/paths";
import { diffLines, followStream, StreamView } from "../src/view";

const scratch = mkdtempSync(join(tmpdir(), "factory-view-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const fixture = readFileSync(join(import.meta.dir, "fixtures/agents/claude/build.jsonl"), "utf8").split("\n");

function render(rows: string[]): string[] {
  const view = new StreamView();
  return rows.flatMap((r) => view.render(r));
}

describe("the stream view", () => {
  const out = render(fixture);
  const text = out.map(stripVTControlCharacters);

  test("an edit shows only its changed lines, removed in red and added in green", () => {
    const at = text.indexOf("● Edit src/money/cents.ts");
    expect(at).toBeGreaterThan(-1);
    expect(out.find((l, i) => i > at && l.includes("- ") && l.includes("const share = Math.floor"))).toStartWith(RED);
    expect(out.find((l, i) => i > at && l.includes("+ ") && l.includes("const remainder"))).toStartWith(GREEN);
    expect(diffLines("a\nb\nc", "a\nB\nc").map(stripVTControlCharacters)).toEqual(["    - b", "    + B"]);
  });

  test("the test run fails red before the fix and passes green after", () => {
    const runs = text.flatMap((l, i) => (l === "● Bash bun test tests/money.test.ts" ? [i] : []));
    expect(runs).toHaveLength(2);
    const failing = out.find((l, i) => i > runs[0]! && stripVTControlCharacters(l).trim() === "2 fail")!;
    const passing = out.find((l, i) => i > runs[1]! && stripVTControlCharacters(l).trim() === "9 pass")!;
    expect(failing).toContain(RED);
    expect(passing).toContain(GREEN);
    expect(text[runs[0]! + 1]).toContain("✗");
    expect(text[runs[1]! + 1]).toContain("✓");
  });

  test("paths print relative to the worktree, and a Read's file contents never print", () => {
    expect(text).toContain("● Read src/money/cents.ts");
    expect(text.some((l) => l.includes("<path>/.factory/workspaces"))).toBe(false);
    expect(text.some((l) => l.includes("export function sumCents"))).toBe(false);
  });

  test("stage markers draw a banner and an exit line; agent text loses its escapes", () => {
    const rows = render([
      JSON.stringify({ type: "factory_stage", stage: "build", issue: 179, at: "t", agent: "claude" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi \x1b[2Jthere" }] } }),
      "not json \x1b]0;title\x07",
      JSON.stringify({ type: "factory_exit", stage: "build", code: 1, reason: "stage exceeded maxToolCalls=5" }),
    ]).map(stripVTControlCharacters);
    expect(rows.some((r) => r.includes("BUILD  #179"))).toBe(true);
    expect(rows).toContain("hi there");
    expect(rows).toContain("not json ");
    expect(rows.at(-1)).toBe("✗ build exit 1 (stage exceeded maxToolCalls=5)");
  });
});

describe("the stream file", () => {
  test("the executor writes the stage marker, every output line and the exit, and view renders it", async () => {
    const dir = mkdtempSync(join(scratch, "home-"));
    mkdirSync(join(dir, ".claude/skills/factory-build"), { recursive: true });
    writeFileSync(join(dir, ".claude/skills/factory-build/SKILL.md"), "build it\n");
    const script = join(dir, "agent.sh");
    writeFileSync(script, "#!/bin/sh\necho first line\necho second line\n", { mode: 0o755 });
    const transcriptFile = transcriptPath("acme/widgets", 3, { FACTORY_HOME: dir });
    const ex = new CommandExecutor({ x: { command: [script] } }, { default: "x" });
    await ex.runStage({ stage: "build", issue: 3, cwd: dir, maxBudgetUsd: 1, transcriptFile });
    const file = streamPath(transcriptFile);
    expect(file).toEndWith("issue-3.stream.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n");
    expect(JSON.parse(rows[0]!)).toMatchObject({ type: "factory_stage", stage: "build", issue: 3, agent: "x" });
    expect(rows.slice(1, 3)).toEqual(["first line", "second line"]);
    expect(JSON.parse(rows[3]!)).toEqual({ type: "factory_exit", stage: "build", code: 0 });
    let shown = "";
    await followStream(file, (t) => (shown += t), { follow: false });
    expect(stripVTControlCharacters(shown)).toContain("first line\nsecond line\n✓ build exit 0");
  });
});
