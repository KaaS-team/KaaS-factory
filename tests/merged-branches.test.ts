// Merged feat/* branches are deleted; an unmerged one never is (#586).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../src/github";
import { deleteIfMerged, sweepMerged } from "../src/merged-branches";

interface Branch {
  prs: { state: string; merged_at: string | null; head: { sha: string } }[];
  tip: string;
}
// A fake GitHub: branches by name, and a log of the DELETE calls.
function fake(branches: Record<string, Branch>) {
  const deleted: string[] = [];
  const runner: CommandRunner = {
    run: async (args) => {
      const url = args.find((a) => a.startsWith("repos/")) ?? "";
      const out = (v: unknown) => ({ stdout: JSON.stringify(v), stderr: "", code: 0 });
      if (args.includes("DELETE")) {
        deleted.push(decodeURIComponent(url.split("/heads/")[1]!));
        return out(null);
      }
      if (url.includes("/pulls?")) return out(branches[decodeURIComponent(url.split(":").pop()!)]?.prs ?? []);
      if (url.includes("/branches?"))
        return out([
          Object.keys(branches)
            .map((name) => ({ name }))
            .concat([{ name: "main" }]),
        ]);
      const b = branches[decodeURIComponent(url.split("/branches/")[1]!)];
      return out({ commit: { sha: b?.tip } });
    },
  };
  return { runner, deleted };
}
const merged = (sha = "a1") => ({ state: "closed", merged_at: "2026-01-01", head: { sha } });

describe("deleteIfMerged", () => {
  test("deletes a feat branch whose PR merged at its tip", async () => {
    const { runner, deleted } = fake({ "feat/a": { prs: [merged()], tip: "a1" } });
    expect(await deleteIfMerged(runner, "o/r", "feat/a")).toBe("deleted");
    expect(deleted).toEqual(["feat/a"]);
  });
  test("keeps a branch whose PR was closed without merging", async () => {
    const { runner, deleted } = fake({
      "feat/b": { prs: [{ state: "closed", merged_at: null, head: { sha: "b1" } }], tip: "b1" },
    });
    expect(await deleteIfMerged(runner, "o/r", "feat/b")).toBe("kept");
    expect(deleted).toEqual([]);
  });
  test("keeps a branch with no PR", async () => {
    const { runner, deleted } = fake({ "feat/c": { prs: [], tip: "c1" } });
    expect(await deleteIfMerged(runner, "o/r", "feat/c")).toBe("kept");
    expect(deleted).toEqual([]);
  });
  test("keeps a merged branch that has an open PR", async () => {
    const { runner, deleted } = fake({
      "feat/d": { prs: [merged("d1"), { state: "open", merged_at: null, head: { sha: "d1" } }], tip: "d1" },
    });
    expect(await deleteIfMerged(runner, "o/r", "feat/d")).toBe("kept");
    expect(deleted).toEqual([]);
  });
  test("keeps a merged branch that has commits past the merge", async () => {
    const { runner, deleted } = fake({ "feat/e": { prs: [merged("e1")], tip: "e2" } });
    expect(await deleteIfMerged(runner, "o/r", "feat/e")).toBe("kept");
    expect(deleted).toEqual([]);
  });
  test("never touches a branch outside feat/", async () => {
    const { runner, deleted } = fake({ "release/x": { prs: [merged()], tip: "a1" } });
    expect(await deleteIfMerged(runner, "o/r", "release/x")).toBe("skipped");
    expect(deleted).toEqual([]);
  });
});

describe("sweepMerged", () => {
  test("removes only the merged feat branches", async () => {
    const { runner, deleted } = fake({
      "feat/done": { prs: [merged("x")], tip: "x" },
      "feat/wip": { prs: [], tip: "w" },
      "feat/abandoned": { prs: [{ state: "closed", merged_at: null, head: { sha: "q" } }], tip: "q" },
      "fix/merged": { prs: [merged("y")], tip: "y" },
    });
    expect(await sweepMerged(runner, "o/r")).toEqual(["feat/done"]);
    expect(deleted).toEqual(["feat/done"]);
  });
});

describe("the staged workflow", () => {
  const wf = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "ci", "merged-branches.yml"), "utf8")) as {
    on: { pull_request: { types: string[] }; workflow_dispatch: unknown };
    jobs: { delete: { if: string; steps: { run?: string }[] } };
  };
  test("runs when a PR closes, guarded to merged same-repo feat/ branches, and on demand for the sweep", () => {
    expect(wf.on.pull_request.types).toEqual(["closed"]);
    expect("workflow_dispatch" in wf.on).toBe(true);
    for (const needle of ["merged == true", "head.repo.full_name == github.repository", "'feat/'"])
      expect(wf.jobs.delete.if).toContain(needle);
    expect(wf.jobs.delete.steps.some((s) => s.run?.includes("scripts/delete-merged-branches.ts"))).toBe(true);
  });
});
