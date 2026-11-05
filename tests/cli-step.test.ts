// A `cli` step runs a tool the repo declares in .factory/cli-tools.json and records its output.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_TOOLS_FILE, cliToolProblems, readCliTools } from "../src/cli-tools";
import { cliStep } from "../src/engine/cli-step";
import { parseWorkflowText } from "../src/engine/workflows";
import { engine, removeEngineDirs } from "./engine-harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  delete process.env.GH_TOKEN;
  removeEngineDirs();
});

const TOOLS = {
  tools: {
    hello: { command: "sh", args: ["-c", 'echo "hello $1 token=[$GH_TOKEN]"', "sh"], expect: "hello" },
    broken: { command: "sh", args: ["-c", "echo boom >&2; exit 3"] },
    picky: { command: "sh", args: ["-c", "echo something else"], expect: "all good" },
  },
};

const declare = () => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "cli-tools-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".factory"));
  writeFileSync(join(dir, CLI_TOOLS_FILE), JSON.stringify(TOOLS));
  return dir;
};

const WORKFLOW = (run: string) => `
name: cli-flow
steps:
  go:
    uses: cli
    label: factory:running-cli
    run: ${run}
    next: done
  done:
    uses: report
    label: factory:reporting
`;

function run(cmd: string) {
  const parsed = parseWorkflowText(WORKFLOW(cmd));
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  process.env.GH_TOKEN = "gh-secret";
  return engine(parsed.workflow, 0, { [CLI_TOOLS_FILE]: JSON.stringify(TOOLS) });
}

describe("declared CLI tools", () => {
  test("a config lists tools by name, command and expected output", () => {
    expect(cliToolProblems(TOOLS)).toEqual([]);
    const tools = readCliTools(declare());
    expect(tools.hello).toEqual({
      command: "sh",
      args: ["-c", 'echo "hello $1 token=[$GH_TOKEN]"', "sh"],
      expect: "hello",
      env: [],
    });
    expect(Object.keys(tools)).toEqual(["hello", "broken", "picky"]);
  });

  test("a malformed declaration is reported with the tool's name", () => {
    expect(cliToolProblems({ tools: { bad: { args: "x", nope: 1 } } }).join("\n")).toMatch(
      /tools\.bad\.nope: unknown key[\s\S]*tools\.bad\.command: required[\s\S]*tools\.bad\.args: must be a list/,
    );
  });

  test("a cli step runs the declared tool, records its output, and never gives it a runner token", async () => {
    const e = run("hello world");
    expect(await e.run()).toBe("shipped");
    expect(e.github.closed).toContain(1);
    expect(e.executor.pinned).toHaveLength(0);
  });

  test("the step's fact is the tool's stdout, and the tool never sees a runner token", async () => {
    process.env.GH_TOKEN = "gh-secret";
    const sc = { deps: { cloneDir: declare() }, step: { run: "hello world" } } as never;
    expect(await cliStep.run(sc)).toEqual({
      kind: "next",
      facts: { ok: true, tool: "hello", code: 0, text: "hello world token=[]\n" },
    });
  });

  test("an undeclared tool is refused with its name", async () => {
    const e = run("nosuch");
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain('cli tool "nosuch" is not declared');
  });

  test("a failing command parks the issue failed with its output", async () => {
    const e = run("broken");
    expect(await e.run()).toBe("failed");
    const body = e.github.issues.get(1)!.comments.at(-1)!.body;
    expect(body).toContain("exited 3");
    expect(body).toContain("boom");
  });

  test("output that misses the declared expectation fails the step", async () => {
    const e = run("picky");
    expect(await e.run()).toBe("failed");
    expect(e.github.issues.get(1)!.comments.at(-1)!.body).toContain('output did not contain "all good"');
  });
});
