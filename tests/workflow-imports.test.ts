// `imports:` pulls shared fragments under a workflow; the resolved result is what loads, shows and runs.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadWorkflow } from "../src/engine/workflows";
import { cmdWorkflow } from "../src/workflow-cli";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const files = (m: Record<string, string>) => async (p: string) => m[p.replace("/clone/", "")];
const load = (name: string, m: Record<string, string>) => loadWorkflow("/clone", name, files(m));
const problems = async (name: string, m: Record<string, string>) => {
  const r = await load(name, m);
  return r.ok ? [] : r.problems;
};

const MAIN = (name: string, imports: string) =>
  `name: ${name}\nimports: ${imports}\nsteps:\n  triage: { uses: triage, label: factory:triaging, next: build }\n  build: { uses: build, label: factory:building, next: lint }\n  pr: { uses: pr, label: factory:in-review, revise: build }\n`;
const LINT = (cmd: string) => `steps:\n  lint: { uses: check, label: "factory:linting", run: "${cmd}", next: pr }\n`;

describe("workflow imports", () => {
  test("a workflow imports a fragment from shared/", async () => {
    const r = await load("a", {
      ".factory/workflows/a.yml": MAIN("a", "[shared/lint]"),
      ".factory/workflows/shared/lint.yml": LINT("make lint"),
    });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(Object.keys(r.workflow.steps)).toContain("lint");
    expect(r.workflow.steps.lint!.run).toBe("make lint");
  });

  test("a workflow imports a fragment from the org and the team files", async () => {
    const r = await load("a", {
      ".factory/workflows/a.yml": MAIN("a", "[org/lint, team/web/extra]"),
      ".factory/team/org.yml": `name: org\nworkflows:\n  lint:\n    steps:\n      lint: { uses: check, label: "factory:linting", run: "make org-lint", next: pr }\n`,
      ".factory/team/teams/web.yml": `name: web\nworkflows:\n  extra:\n    limits: { rejects: 5 }\n`,
    });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.workflow.steps.lint!.run).toBe("make org-lint");
    expect(r.workflow.limits.rejects).toBe(5);
  });

  test("the importing file wins over its fragment", async () => {
    const text = `${MAIN("a", "[shared/lint]")}  lint: { uses: check, label: "factory:linting", run: "mine", next: pr }\n`;
    const r = await load("a", {
      ".factory/workflows/a.yml": text,
      ".factory/workflows/shared/lint.yml": LINT("theirs"),
    });
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.workflow.steps.lint!.run).toBe("mine");
  });

  test("a missing fragment is one line naming the file", async () => {
    expect(await problems("a", { ".factory/workflows/a.yml": MAIN("a", "[shared/nope]") })).toEqual([
      "imports: shared/nope not found (.factory/workflows/shared/nope.yml)",
    ]);
  });

  test("a cycle is one line naming it", async () => {
    expect(
      await problems("a", {
        ".factory/workflows/a.yml": MAIN("a", "[shared/x]"),
        ".factory/workflows/shared/x.yml": "imports: [shared/y]\n",
        ".factory/workflows/shared/y.yml": "imports: [shared/x]\n",
      }),
    ).toEqual(["imports: cycle shared/x -> shared/y -> shared/x"]);
  });

  test("a fragment cannot set the workflow's name", async () => {
    const [p] = await problems("a", {
      ".factory/workflows/a.yml": MAIN("a", "[shared/x]"),
      ".factory/workflows/shared/x.yml": "name: other\n",
    });
    expect(p).toContain('shared/x has "name"');
  });

  test("a fragment change reaches every workflow that imports it", async () => {
    const at = (cmd: string) => ({
      ".factory/workflows/a.yml": MAIN("a", "[shared/lint]"),
      ".factory/workflows/b.yml": MAIN("b", "[shared/lint]"),
      ".factory/workflows/shared/lint.yml": LINT(cmd),
    });
    const before = [await load("a", at("make lint")), await load("b", at("make lint"))];
    const after = [await load("a", at("make lint-strict")), await load("b", at("make lint-strict"))];
    for (const [i, r] of after.entries()) {
      if (!r.ok || !before[i]!.ok) throw new Error("did not load");
      expect(r.workflow.steps.lint!.run).toBe("make lint-strict");
      expect(r.workflow.sha).not.toBe((before[i] as { workflow: { sha: string } }).workflow.sha);
    }
  });
});

describe("factory workflow show", () => {
  test("prints the resolved workflow, imports applied", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "factory-imports-"));
    dirs.push(dir);
    const put = (p: string, t: string) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    put(".factory/workflows/a.yml", MAIN("a", "[shared/lint]"));
    put(".factory/workflows/shared/lint.yml", LINT("make lint"));
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => void out.push(s);
    try {
      await cmdWorkflow({
        args: ["workflow", "show", "a"],
        flag: () => undefined,
        has: () => false,
        cloneDir: async () => dir,
        watchDeps: async () => {
          throw new Error("show reads no deps");
        },
        statePath: () => "",
      });
    } finally {
      console.log = log;
    }
    const shown = JSON.parse(out.join("\n"));
    expect(shown.steps.lint.run).toBe("make lint");
  });
});
