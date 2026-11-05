// Before and after shots on the orphan factory/assets branch (src/assets-branch.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBaseBaseline,
  publishShots,
  pairShots,
  pushAssets,
  runGit,
  shotUrls,
  shotsSection,
} from "../src/assets-branch";
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
      "| `fresh.png` | _none_ | ![](https://raw.githubusercontent.com/o/r/factory/assets/5/after/fresh.png) |",
    );
    expect(shotsSection(urls)).toContain("factory/assets/5/before/home.png");
    expect(prBody("b", { shots: [] })).not.toContain("Screenshots");
  });
});

describe("before images come from the base branch", () => {
  test("a baseline edited on the change is not the before image", async () => {
    const root = scratch("factory-base-test-");
    try {
      const wt = join(root, "wt");
      mkdirSync(join(wt, ".factory/visual/baseline"), { recursive: true });
      await git(wt, "init", "-q", "-b", "main");
      writeFileSync(join(wt, ".factory/visual/baseline/home.png"), "base-image");
      await git(wt, "add", ".");
      await git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      await git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
      writeFileSync(join(wt, ".factory/visual/baseline/home.png"), "changed-image");
      const dir = extractBaseBaseline(wt, "origin/main", join(root, "out"));
      expect(readFileSync(join(dir!, "home.png"), "utf8")).toBe("base-image");
      expect(extractBaseBaseline(wt, "origin/nope", join(root, "out2")) === undefined).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("publishShots", () => {
  test("pushes the base branch image as before and the new capture as after", async () => {
    const root = scratch("factory-publish-test-");
    try {
      const remote = join(root, "remote.git");
      const wt = join(root, "wt");
      mkdirSync(join(wt, ".factory/visual/baseline"), { recursive: true });
      await git(root, "init", "-q", "--bare", remote);
      await git(wt, "init", "-q", "-b", "main");
      await git(wt, "remote", "add", "origin", remote);
      writeFileSync(join(wt, ".factory/visual/baseline/home.png"), "base-image");
      await git(wt, "add", ".");
      await git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
      await git(wt, "update-ref", "refs/remotes/origin/main", "HEAD");
      writeFileSync(join(wt, ".factory/visual/baseline/home.png"), "edited-on-change");
      mkdirSync(join(wt, ".factory/runs/issue-9/visual"), { recursive: true });
      writeFileSync(join(wt, ".factory/runs/issue-9/visual/home.png"), "after-image");
      const urls = await publishShots(runGit, wt, { repo: "o/r", issue: 9, changed: ["app/page.tsx"], base: "main" });
      expect(urls?.[0]?.before).toContain("/9/before/home.png");
      expect(await git(remote, "show", "factory/assets:9/before/home.png")).toBe("base-image");
      expect(await git(remote, "show", "factory/assets:9/after/home.png")).toBe("after-image");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
