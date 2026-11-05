// E13.3: lessons expire after a set age, and the learn PR proposes the hygiene changes.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack, expireLessons, LESSON_MAX_AGE_DAYS, LESSONS_PATH } from "../src/context";
import { branchNameFor, runLearn } from "../src/learn";
import { FactoryState } from "../src/state";
import { FakeGit, FakeGitHub } from "./harness";

mkdirSync(tmpdir(), { recursive: true });
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const NOW = new Date("2026-09-27T12:00:00Z");
const OLD = "- Old habit (issue #1, learned 2026-01-02)";
const FRESH = "- Fresh habit (issue #2, learned 2026-09-01)";
const UNDATED = "- Undated habit (issue #3)";

describe("lessons expire", () => {
  test("a lesson older than the age limit is dropped, newer and undated ones stay", () => {
    const { kept, expired } = expireLessons([OLD, FRESH, UNDATED].join("\n"), NOW);
    expect(expired).toEqual([OLD]);
    expect(kept).toContain("Fresh habit");
    expect(kept).toContain("Undated habit");
    expect(kept).not.toContain("Old habit");
    expect(LESSON_MAX_AGE_DAYS).toBe(90);
  });

  test("the context pack leaves an expired lesson out", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "factory-expire-"));
    dirs.push(cwd);
    mkdirSync(`${cwd}/.factory/memory`, { recursive: true });
    writeFileSync(join(cwd, LESSONS_PATH), `${[OLD, FRESH].join("\n")}\n`);
    const pack = await buildContextPack("triage", 1, cwd, { now: NOW });
    expect(pack).toContain("Fresh habit");
    expect(pack).not.toContain("Old habit");
  });
});

describe("the learn PR proposes hygiene changes", () => {
  function setup() {
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-hyg-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-hyg-clone-"));
    dirs.push(workspacesDir, cloneDir);
    const github = new FakeGitHub([]);
    const git = new FakeGit();
    const state = new FactoryState(":memory:");
    return { github, git, state, cloneDir, workspacesDir, deps: { github, git, state, cloneDir, workspacesDir } };
  }
  const seed = (dir: string) => {
    mkdirSync(`${dir}/.factory/memory`, { recursive: true });
    writeFileSync(join(dir, LESSONS_PATH), `${[OLD, FRESH].join("\n")}\n`);
  };

  test("with nothing pending, an expired lesson still opens a PR that removes it and names it", async () => {
    const { deps, cloneDir, workspacesDir, git, github } = setup();
    seed(cloneDir);
    const wt = join(workspacesDir, branchNameFor(NOW).replace(/\//g, "-"));
    seed(wt);
    git.changed = [LESSONS_PATH];
    const result = await runLearn(deps, "acme/widgets", "main", NOW);
    expect(result.batched).toBe(0);
    expect(result.prUrl).toBe(github.prs[0]!.url);
    const text = await Bun.file(join(wt, LESSONS_PATH)).text();
    expect(text).not.toContain("Old habit");
    expect(text).toContain("Fresh habit");
    const body = github.createdPrs[0]!.body;
    expect(body).toContain("Context hygiene");
    expect(body).toContain("Old habit");
  });

  test("nothing pending and nothing expired opens no PR", async () => {
    const { deps, cloneDir, github } = setup();
    mkdirSync(`${cloneDir}/.factory/memory`, { recursive: true });
    writeFileSync(join(cloneDir, LESSONS_PATH), `${FRESH}\n`);
    expect(await runLearn(deps, "acme/widgets", "main", NOW)).toEqual({ batched: 0 });
    expect(github.createdPrs).toEqual([]);
  });

  test("a new lesson is dated, so it can expire later", async () => {
    const { deps, state, git, workspacesDir } = setup();
    const id = state.queueRetro("acme/widgets", 7, "merged");
    state.completeRetro(id, { lesson: "Write the test first." });
    git.changed = [LESSONS_PATH];
    await runLearn(deps, "acme/widgets", "main", NOW);
    const wt = join(workspacesDir, branchNameFor(NOW).replace(/\//g, "-"));
    expect(await Bun.file(join(wt, LESSONS_PATH)).text()).toContain("(issue #7, learned 2026-09-27)");
  });

  test("a PR over the always-loaded cap says so", async () => {
    const { deps, state, git, github } = setup();
    const id = state.queueRetro("acme/widgets", 8, "merged");
    state.completeRetro(id, { lesson: "x" });
    git.changed = [LESSONS_PATH];
    // The worktree is empty, so seed a big context file into the one the fake git makes.
    const wt = join(deps.workspacesDir, branchNameFor(NOW).replace(/\//g, "-"));
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "CLAUDE.md"), "x".repeat(40_000));
    await runLearn(deps, "acme/widgets", "main", NOW);
    expect(github.createdPrs[0]!.body).toContain("over the");
  });
});
