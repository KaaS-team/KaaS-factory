// After a merge, a failing live smoke opens a revert PR, and the change failure rate tightens limits.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeFailureRate, revertBranch, tightenThresholds, watchAfterMerge } from "../src/post-merge";

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .stdout.toString()
    .trim();

test("a failing live smoke after merge opens a revert PR, and the change failure rate tightens thresholds", async () => {
  const opened: string[] = [];
  const steps = (ok: boolean) => ({
    smoke: async () => ok,
    openRevert: async (sha: string) => (opened.push(sha), `pr/${sha}`),
  });
  expect(await watchAfterMerge("abc", steps(true))).toEqual({ ok: true });
  expect(await watchAfterMerge("def", steps(false))).toEqual({ ok: false, revert: "pr/def" });
  expect(opened).toEqual(["def"]);

  const repo = mkdtempSync(join(tmpdir(), "revert-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "good");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "good");
  writeFileSync(join(repo, "a.txt"), "bad");
  git(repo, "commit", "-qam", "bad");
  const bad = git(repo, "rev-parse", "HEAD");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "user.email", "t@t");
  expect(await revertBranch(repo, bad)).toBe(`factory/revert-${bad.slice(0, 7)}`);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("good");

  const merges = (failed: number) => Array.from({ length: 10 }, (_, i) => ({ reverted: i < failed }));
  const limits = { maxFiles: 10, maxLines: 200 };
  expect(changeFailureRate(merges(1))).toBe(0.1);
  expect(tightenThresholds(limits, "full", changeFailureRate(merges(1)))).toEqual({ limits, mode: "full" });
  expect(tightenThresholds(limits, "full", changeFailureRate(merges(2)))).toEqual({
    limits: { maxFiles: 5, maxLines: 100 },
    mode: "full",
  });
  expect(tightenThresholds(limits, "full", changeFailureRate(merges(4))).mode).toBe("supervised");
});
