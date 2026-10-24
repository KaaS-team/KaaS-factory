// v2.10.0 item 4: `factory learn` batches pending retro proposals (lessons and
// skill edits) into one PR on a daily learning branch, never touching
// anything outside its allowed paths, and never re-batching a row twice.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEARNING_ALLOWED_PATHS, branchNameFor, runLearn } from "../src/learn";
import { FactoryState } from "../src/state";
import { FakeGit, FakeGitHub } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-learn-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-learn-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const github = new FakeGitHub([]);
  const git = new FakeGit();
  const state = new FactoryState(":memory:");
  const repo = "acme/widgets";
  return { github, git, state, cloneDir, workspacesDir, repo, deps: { github, git, state, cloneDir, workspacesDir } };
}

const NOW = new Date("2026-09-27T12:00:00Z");

describe("factory learn", () => {
  test("does nothing when there is nothing pending", async () => {
    const { deps, repo } = setup();
    const result = await runLearn(deps, repo, "main", NOW);
    expect(result).toEqual({ batched: 0 });
    expect(deps.git.pushedBranches).toEqual([]);
    expect(deps.github.createdPrs).toEqual([]);
  });

  test("batches a lesson into lessons.md, pushes the branch and opens a PR, then marks the row learned", async () => {
    const { deps, repo, git, state } = setup();
    const id = state.queueRetro(repo, 7, "merged");
    state.completeRetro(id, { lesson: "Always add a regression test for the exact bug." });

    git.changed = [".factory/memory/lessons.md"];
    const result = await runLearn(deps, repo, "main", NOW);

    expect(result.batched).toBe(1);
    expect(result.branch).toBe(branchNameFor(NOW));
    expect(deps.git.pushedBranches).toEqual([branchNameFor(NOW)]);
    expect(deps.github.createdPrs).toHaveLength(1);
    expect(deps.github.createdPrs[0]!.base).toBe("main");
    expect(deps.github.createdPrs[0]!.head).toBe(branchNameFor(NOW));
    expect(result.prUrl).toBe(deps.github.prs[0]!.url);

    const lessonsPath = join(deps.workspacesDir, branchNameFor(NOW).replace(/\//g, "-"), ".factory/memory/lessons.md");
    expect(await Bun.file(lessonsPath).text()).toContain("Always add a regression test for the exact bug.");

    // Row is stamped learned, so a second run has nothing pending.
    expect(state.pendingLessons(repo)).toEqual([]);
  });

  test("batches a skill edit into that skill's PROPOSED_EDITS.md, not the real SKILL.md", async () => {
    const { deps, repo, git, state } = setup();
    const id = state.queueRetro(repo, 9, "gave-up");
    state.completeRetro(id, {
      skill_name: "factory-build",
      skill_edit: "Call out the exact acceptance criterion wording.",
    });

    git.changed = [".claude/skills/factory-build/PROPOSED_EDITS.md"];
    const result = await runLearn(deps, repo, "main", NOW);

    expect(result.batched).toBe(1);
    const path = join(
      deps.workspacesDir,
      branchNameFor(NOW).replace(/\//g, "-"),
      ".claude/skills/factory-build/PROPOSED_EDITS.md",
    );
    const body = await Bun.file(path).text();
    expect(body).toContain("Call out the exact acceptance criterion wording.");
    expect(body).toContain("#9");
  });

  test("refuses to push, and leaves the row pending, when a batch would touch a disallowed path", async () => {
    const { deps, repo, git, state } = setup();
    const id = state.queueRetro(repo, 3, "rejected");
    state.completeRetro(id, { lesson: "Something worth remembering." });

    // Simulate a bug that wrote outside .factory/memory or .claude/skills.
    git.changed = ["src/watch.ts"];

    await expect(runLearn(deps, repo, "main", NOW)).rejects.toThrow(/outside its allowed paths/);
    expect(deps.git.pushedBranches).toEqual([]);
    expect(deps.github.createdPrs).toEqual([]);
    // Never marked learned, so it's still pending for a fixed run to pick up.
    expect(state.pendingLessons(repo)).toHaveLength(1);
  });

  test("a second same-day run reuses the existing open PR instead of opening a new one", async () => {
    const { deps, repo, git, state } = setup();
    const id1 = state.queueRetro(repo, 1, "merged");
    state.completeRetro(id1, { lesson: "First lesson." });
    git.changed = [".factory/memory/lessons.md"];
    await runLearn(deps, repo, "main", NOW);
    expect(deps.github.createdPrs).toHaveLength(1);

    const id2 = state.queueRetro(repo, 2, "merged");
    state.completeRetro(id2, { lesson: "Second lesson." });
    git.changed = [".factory/memory/lessons.md"];
    const second = await runLearn(deps, repo, "main", NOW);

    expect(deps.github.createdPrs).toHaveLength(1); // reused, not a second PR
    expect(second.prUrl).toBe(deps.github.prs[0]!.url);
  });

  test("LEARNING_ALLOWED_PATHS covers exactly memory and skills, the branch's one exemption from protectedPaths", () => {
    expect(LEARNING_ALLOWED_PATHS).toEqual([".factory/memory/**", ".claude/skills/**"]);
  });
});
