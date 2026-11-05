// The bundled catalog: `factory workflow list --catalog` and `add`, and the scheduled repo-health
// workflows it gained. Each of those runs on a fixture whose triage refuses, and parks with no PR.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkflow } from "../src/engine/workflows";
import { LABEL } from "../src/labels";
import { addFromCatalog, catalog, formatCatalog } from "../src/workflow-catalog";
import { engine, removeEngineDirs } from "./engine-harness";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "factory-catalog-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  removeEngineDirs();
});
const fresh = () => mkdtempSync(join(root, "repo-"));
const cli = join(import.meta.dir, "..", "bin", "factory");
const run = (...a: string[]) => Bun.spawnSync(["bun", cli, ...a], { stdout: "pipe", stderr: "pipe" });

const NEW: Record<string, string> = {
  "ci-cost-review": "ci is steady",
  "docs-drift": "docs match the code",
  "duplicate-clusters": "no duplicates",
  "api-breaking-changes": "no public change",
  "weekly-report": "no runs this week",
};

describe("workflow catalog", () => {
  test("list --catalog prints one line per bundled workflow, scheduled ones marked", () => {
    const r = run("workflow", "list", "--catalog");
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.toString().trimEnd().split("\n");
    expect(lines).toEqual(formatCatalog(catalog()));
    expect(lines.length).toBe(catalog().length);
    for (const name of ["feature-to-pr", ...Object.keys(NEW)])
      expect(lines.filter((l) => l.startsWith(`${name} `))).toHaveLength(1);
    for (const l of lines) expect(l.split(/\s{2,}/)[1]?.length).toBeGreaterThan(0);
    expect(lines.find((l) => l.startsWith("weekly-report"))).toContain("[scheduled]");
    expect(lines.find((l) => l.startsWith("feature-to-pr"))).not.toContain("[scheduled]");
  });

  test("add copies the bundled file into .factory/workflows and it loads from there", async () => {
    const dir = fresh();
    expect(addFromCatalog(dir, "docs-drift")).toEqual({ path: ".factory/workflows/docs-drift.md" });
    const copy = join(dir, ".factory/workflows/docs-drift.md");
    expect(readFileSync(copy, "utf8")).toContain("name: docs-drift");
    const loaded = await loadWorkflow(dir, "docs-drift");
    expect(loaded.ok).toBe(true);
    // a .yml workflow is copied under its own extension
    expect(addFromCatalog(dir, "bug-to-pr")).toEqual({ path: ".factory/workflows/bug-to-pr.yml" });
  });

  test("add never overwrites, and refuses a name the catalog lacks", () => {
    const dir = fresh();
    mkdirSync(join(dir, ".factory/workflows"), { recursive: true });
    writeFileSync(join(dir, ".factory/workflows/docs-drift.md"), "mine");
    expect(addFromCatalog(dir, "docs-drift")).toEqual({
      problems: [".factory/workflows/docs-drift.md exists; add never overwrites"],
    });
    expect(readFileSync(join(dir, ".factory/workflows/docs-drift.md"), "utf8")).toBe("mine");
    for (const bad of ["nope", "../etc/passwd"]) {
      const out = addFromCatalog(dir, bad);
      expect(out).toHaveProperty("problems");
    }
  });

  test("add checks the file first: an invalid bundled workflow is not written", () => {
    const bundled = fresh();
    writeFileSync(join(bundled, "broken.yml"), "name: broken\nsteps: nope\n");
    const dir = fresh();
    const out = addFromCatalog(dir, "broken", bundled);
    expect(out).toHaveProperty("problems");
    expect(existsSync(join(dir, ".factory/workflows/broken.yml"))).toBe(false);
  });

  test("the workflow command adds from the command line and exits 4 on a refusal", () => {
    const dir = fresh();
    const ok = run("workflow", "add", "weekly-report", "--repo-dir", dir);
    expect(ok.exitCode).toBe(0);
    expect(existsSync(join(dir, ".factory/workflows/weekly-report.md"))).toBe(true);
    const again = run("workflow", "add", "weekly-report", "--repo-dir", dir);
    expect(again.exitCode).toBe(4);
    expect(run("workflow", "list", "--repo-dir", dir).stdout.toString()).toBe("weekly-report.md\n");
    expect(run("workflow", "add", "--repo-dir", dir).exitCode).not.toBe(0);
  });
});

describe("scheduled repo-health workflows", () => {
  test("the catalog has all five, each on a weekly schedule that tells triage to refuse", async () => {
    const names = catalog().map((e) => e.name);
    for (const [name, refusal] of Object.entries(NEW)) {
      expect(names).toContain(name);
      const loaded = await loadWorkflow(fresh(), name);
      if (!loaded.ok) throw new Error(loaded.problems.join("; "));
      expect(loaded.workflow.triggers.cron).toHaveLength(1);
      const file = join(import.meta.dir, "..", "template/.factory/workflows", `${name}.md`);
      expect(readFileSync(file, "utf8").replace(/\s+/g, " ")).toContain(`triage refuses with "${refusal}"`);
    }
  });

  for (const name of Object.keys(NEW)) {
    test(`${name}: with nothing to do, triage refuses, the issue parks and no PR opens`, async () => {
      const loaded = await loadWorkflow(fresh(), name);
      if (!loaded.ok) throw new Error(loaded.problems.join("; "));
      const e = engine(
        loaded.workflow,
        0,
        {},
        {},
        {},
        {
          outputs: {
            triage: [
              {
                "triage-comment.md": "<!-- factory:triage v1 -->\nnothing to do",
                "triage.json": JSON.stringify({
                  disposition: "refused",
                  type: "bug",
                  risk: "low",
                  done_when: "x",
                  files_expected: ["a"],
                  gate_level: "x",
                  confidence: 0.9,
                }),
              },
            ],
          },
        },
      );
      expect(await e.run()).toBe("needs-human");
      expect(e.github.issues.get(1)!.labels.map((l) => l.name)).toEqual([LABEL.needsHuman]);
      expect(e.github.createdPrs).toHaveLength(0);
      expect(e.executor.pinned.map(([stage]) => stage)).toEqual(["triage"]);
    });

    test(`${name}: with something to report, triage proceeds and the report step closes the issue`, async () => {
      const loaded = await loadWorkflow(fresh(), name);
      if (!loaded.ok) throw new Error(loaded.problems.join("; "));
      const e = engine(loaded.workflow, 0);
      expect(await e.run()).toBe("shipped");
      expect(e.github.closed).toContain(1);
      expect(e.github.createdPrs).toHaveLength(0);
    });
  }
});
