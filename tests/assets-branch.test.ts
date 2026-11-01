// Before and after shots on the orphan factory/assets branch (src/assets-branch.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pairShots, pushAssets, runGit, shotUrls, shotsSection } from "../src/assets-branch";
import { prBody } from "../src/engine/pr-body";

// The per-run temp parent can be gone on a rerun, so it is recreated before each mkdtemp.
const scratch = (prefix: string) => {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
};

const git = (cwd: string, ...args: string[]) => runGit(cwd, args);

describe("assets branch", () => {
  test("two pushes make a two-commit history, the first with no parent, and the worktree does not move", async () => {
    const root = scratch("factory-assets-test-");
    try {
      const remote = join(root, "remote.git");
      const wt = join(root, "wt");
      mkdirSync(wt);
      await git(root, "init", "-q", "--bare", remote);
      await git(wt, "init", "-q");
      await git(wt, "remote", "add", "origin", remote);
      writeFileSync(join(wt, "a.txt"), "a");
      await git(wt, "add", "a.txt");
      await git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      for (const d of ["base", "cur"]) mkdirSync(join(wt, d));
      writeFileSync(join(wt, "base/home.png"), "old-home");
      writeFileSync(join(wt, "cur/home.png"), "new-home");
      writeFileSync(join(wt, "cur/fresh.png"), "fresh");
      const pairs = pairShots(join(wt, "base"), join(wt, "cur"));
      const headBefore = await git(wt, "rev-parse", "HEAD");
      const indexBefore = readFileSync(join(wt, ".git/index"));

      await pushAssets(runGit, wt, 5, pairs);
      await pushAssets(runGit, wt, 6, pairs);

      const log = (await git(remote, "log", "factory/assets", "--format=%H %P")).split("\n");
      expect(log).toHaveLength(2);
      expect(log[1]!.split(" ").filter(Boolean)).toHaveLength(1); // the oldest has only its own hash
      expect(log[0]!.split(" ")[1]).toBe(log[1]!.split(" ")[0]!);
      const files = (await git(remote, "ls-tree", "-r", "--name-only", "factory/assets")).split("\n");
      expect(files).toContain("5/before/home.png");
      expect(files).toContain("6/after/fresh.png");
      expect(files).not.toContain("6/before/fresh.png");
      expect(await git(wt, "rev-parse", "HEAD")).toBe(headBefore);
      expect(readFileSync(join(wt, ".git/index")).equals(indexBefore)).toBe(true);
      expect(await git(wt, "status", "--porcelain")).toContain("cur/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("a pair missing before reads new screen, and the body links raw URLs", () => {
    const urls = shotUrls("o/r", 5, [
      { name: "fresh.png", after: "/x" },
      { name: "home.png", before: "/y", after: "/x" },
    ]);
    const body = prBody("b", { shots: urls });
    expect(body).toContain(
      "| new screen | ![after fresh.png](https://raw.githubusercontent.com/o/r/factory/assets/5/after/fresh.png) |",
    );
    expect(shotsSection(urls)).toContain("factory/assets/5/before/home.png");
    expect(prBody("b", { shots: [] })).not.toContain("Screenshots");
  });
});
