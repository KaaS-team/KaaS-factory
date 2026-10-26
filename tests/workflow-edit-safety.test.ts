// The workflow form takes step and field names from a browser and files from the repo, so neither
// a poisoned key nor a planted symlink may reach outside the one workflow file it edits.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeFiles } from "../src/propose-pr";
import { applyForm, workflowSource } from "../src/workflow-edit";
import { FakeGit, FakeGitHub } from "./harness";

const root = mkdtempSync(join(tmpdir(), "factory-wf-safety-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const YML = "name: x\nsteps:\n  build:\n    uses: build\n    label: factory:building\n";

describe("workflow form safety", () => {
  test("a form keyed __proto__ or constructor is refused and never pollutes Object.prototype", () => {
    const form = JSON.parse('{"__proto__": {"timeout": 5, "polluted": 1}, "constructor": {"agent": "x"}}');
    const out = applyForm(YML, form);
    expect("problems" in out && out.problems).toEqual(["__proto__: no such step", "constructor: no such step"]);
    expect(({} as Record<string, unknown>).timeout).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(applyForm(YML, JSON.parse('{"build": {"__proto__": {"agent": "x"}}}'))).toEqual({
      problems: ["build.__proto__: not an editable field"],
    });
  });

  test("a symlinked workflow file pointing outside is neither read nor written through", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "runner secret");
    const clone = join(root, "clone");
    mkdirSync(join(clone, ".factory", "workflows"), { recursive: true });
    symlinkSync(secret, join(clone, ".factory", "workflows", "x.md"));
    expect(workflowSource(clone, "x")).toBeUndefined();

    const workspacesDir = join(root, "ws");
    const deps = { github: new FakeGitHub([]), git: new FakeGit(), cloneDir: clone, workspacesDir };
    const p = (branch: string) => ({
      repo: "o/r",
      base: "main",
      branch,
      files: { ".factory/workflows/x.md": "overwritten" },
      allowed: [".factory/workflows/**"],
      title: "t",
      body: "b",
    });
    const fileLink = join(workspacesDir, "a", ".factory", "workflows");
    mkdirSync(fileLink, { recursive: true });
    symlinkSync(secret, join(fileLink, "x.md"));
    await expect(proposeFiles(deps, p("a"))).rejects.toThrow("symlink");
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir);
    mkdirSync(join(workspacesDir, "b", ".factory"), { recursive: true });
    symlinkSync(outsideDir, join(workspacesDir, "b", ".factory", "workflows"));
    await expect(proposeFiles(deps, p("b"))).rejects.toThrow("symlink");
    expect(readFileSync(secret, "utf8")).toBe("runner secret");
    expect(() => readFileSync(join(outsideDir, "x.md"))).toThrow();
    expect(deps.github.createdPrs).toHaveLength(0);
  });
});
