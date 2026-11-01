// Backport planning and the runner against real repos: a clean pick pushes, a conflict aborts and moves on.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backportTargets, planBackport, runBackport } from "../src/backport";
import { GitCommandRunner } from "../src/git";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

describe("backportTargets", () => {
  test("reads backport labels, drops the base, duplicates and unsafe names", () => {
    const labels = [
      "bug",
      "backport:release/1.x",
      "backport:release/1.x",
      "backport:main",
      "backport:-x",
      "backport:a..b",
    ];
    expect(backportTargets(labels, "main")).toEqual(["release/1.x"]);
  });
});

describe("planBackport", () => {
  test("a squash commit is picked plainly, a merge commit takes mainline 1", () => {
    const [squash] = planBackport({ sha: "abc", pr: 7, parents: 1, branches: ["release/1.x"] });
    expect(squash?.work).toBe("backport/7-release-1.x");
    expect(squash?.steps).toEqual([
      ["fetch", "origin", "release/1.x"],
      ["switch", "-C", "backport/7-release-1.x", "origin/release/1.x"],
      ["cherry-pick", "-x", "abc"],
      ["push", "origin", "backport/7-release-1.x:backport/7-release-1.x"],
    ]);
    const [merge] = planBackport({ sha: "abc", pr: 7, parents: 2, branches: ["r"] });
    expect(merge?.steps[2]).toEqual(["cherry-pick", "-x", "-m", "1", "abc"]);
  });
});

describe("runBackport", () => {
  test("pushes a clean pick, aborts a conflict, and carries on", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "backport-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const work = join(root, "work");
    await git(root, "init", "-q", "--bare", "-b", "main", origin);
    await git(root, "clone", "-q", origin, work);
    const put = (f: string, text: string) => writeFileSync(join(work, f), text);
    put("a.txt", "one\n");
    put("b.txt", "base\n");
    await git(work, "add", ".");
    await git(work, "commit", "-q", "-m", "base");
    await git(work, "push", "-q", "origin", "HEAD:main");
    await git(work, "push", "-q", "origin", "HEAD:refs/heads/clean");
    await git(work, "switch", "-q", "-c", "stale");
    put("a.txt", "release edit\n");
    await git(work, "commit", "-qam", "release edit");
    await git(work, "push", "-q", "origin", "stale");
    await git(work, "switch", "-q", "main");
    put("a.txt", "main edit\n");
    await git(work, "commit", "-qam", "fix");
    await git(work, "push", "-q", "origin", "main");
    const sha = await git(work, "rev-parse", "HEAD");

    const plans = planBackport({ sha, pr: 9, parents: 1, branches: ["stale", "clean"] });
    const results = await runBackport(plans, new GitCommandRunner(), work);

    expect(results).toEqual([
      { branch: "stale", outcome: "conflict" },
      { branch: "clean", outcome: "pushed" },
    ]);
    expect(await git(origin, "show", "backport/9-clean:a.txt")).toBe("main edit");
    expect(await git(work, "status", "--porcelain")).toBe("");
  });
});
