// #497: a build that edits template/** runs the full suite, so a test in another file cannot hide.

import { describe, expect, test } from "bun:test";
import type { FactoryConfig, GateSpec } from "../src/config";
import { gateList, scopeGateRun, touchesTemplate } from "../src/gates";
import { STEP_TYPES, type StepCtx } from "../src/engine/steps";

const gates: GateSpec[] = [
  { name: "lint", cmd: "make lint", required: true, role: "lint" },
  { name: "check", cmd: "make check", required: true, role: "test" },
];

describe("gate list for a template diff", () => {
  test("a template/** file adds the test gate, which runs the whole suite", () => {
    expect(gateList(["lint"], ["template/.claude/agents/x.md"], gates)).toEqual(["lint", "check"]);
  });
  test("a diff outside template/ leaves the list as named", () => {
    expect(gateList(["lint"], ["src/config.ts"], gates)).toEqual(["lint"]);
    expect(touchesTemplate(["templates-doc.md", "docs/template/a.md"])).toBe(false);
  });
  test("the test gate is not listed twice", () => {
    expect(gateList(["check"], ["template/a.md"], gates)).toEqual(["check"]);
  });
  test("a repo with no test gate has nothing to add", () => {
    expect(gateList(["lint"], ["template/a.md"], gates.slice(0, 1))).toEqual(["lint"]);
  });
  test("the command string carries the widened list; other commands pass through", async () => {
    const run = "FACTORY_GATES_ONLY=lint bash .factory/gates.sh";
    const diff = (files: string[]) => ({ changedFiles: async () => files });
    const config = { base: "main", gates };
    expect(await scopeGateRun(run, diff(["template/a.md"]), "/w", config)).toBe(
      "FACTORY_GATES_ONLY=lint,check bash .factory/gates.sh",
    );
    expect(await scopeGateRun(run, diff(["src/a.ts"]), "/w", config)).toBe(run);
    expect(await scopeGateRun("make lint", diff(["template/a.md"]), "/w", config)).toBe("make lint");
  });
});

// The call site: the runner's check step, with a scripted runtime and diff.
async function runCheck(changed: string[], run: string): Promise<string> {
  const ran: string[] = [];
  const sc = {
    deps: {
      git: { changedFiles: async () => changed },
      setupRunner: {
        run: async (cmd: string) => {
          ran.push(cmd);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    },
    config: { gates, base: "main", runtime: undefined } as unknown as FactoryConfig,
    worktree: "/w",
    step: { id: "build-gates", run },
  } as unknown as StepCtx;
  const result = await STEP_TYPES.check!.run(sc);
  expect(result.kind).toBe("next");
  expect(ran).toHaveLength(1);
  return ran[0]!;
}

describe("the check step", () => {
  const run = "FACTORY_GATES_ONLY=lint bash .factory/gates.sh";
  test("runs the full suite gate when the diff touches template/**", async () => {
    expect(await runCheck(["template/.factory/gates.sh"], run)).toBe(
      "FACTORY_GATES_ONLY=lint,check bash .factory/gates.sh",
    );
  });
  test("keeps the named gates for any other diff", async () => {
    expect(await runCheck(["src/gates.ts"], run)).toBe(run);
  });
});
