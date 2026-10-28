// Two properties that were flat-out bugs before this refactor, both only
// provable against a real git repo:
//   - claim() is a real compare-and-swap (audit finding #3): pushing the
//     same base SHA twice used to be a fast-forward no-op that let two
//     racing watchers both "win" the same issue.
//   - commitAll() excludes `.factory/runs` (audit finding #4): that
//     directory is the stage handoff, never meant to land in the target repo.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";

// Real git processes: a loaded machine can exceed bun's 5s default.
setDefaultTimeout(30_000);
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, GitCommandRunner, issueOfPr, sparseCheckoutPatterns } from "../src/git";

const roots: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-git-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} (cwd=${cwd}) failed: ${stderr}`);
  return stdout;
}

async function initSeededRepo(dir: string): Promise<void> {
  await run(["git", "init", "-b", "main", dir], dir);
  await run(["git", "config", "user.email", "t@example.com"], dir);
  await run(["git", "config", "user.name", "t"], dir);
  writeFileSync(join(dir, "README.md"), "seed\n");
  await run(["git", "add", "-A"], dir);
  await run(["git", "commit", "-m", "seed"], dir);
}

// A bare "origin" plus two independent clones, each standing in for a
// separate watcher process/machine claiming against the same repo.
async function bareOriginWithClones(root: string, names: string[]): Promise<{ bare: string; clones: string[] }> {
  const bare = join(root, "origin.git");
  mkdirSync(bare, { recursive: true });
  await run(["git", "init", "--bare", "-b", "main", bare], root);

  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  await initSeededRepo(seed);
  await run(["git", "remote", "add", "origin", bare], seed);
  await run(["git", "push", "origin", "main"], seed);

  const clones = names.map((n) => join(root, n));
  for (const clone of clones) await run(["git", "clone", bare, clone], root);
  return { bare, clones };
}

describe("Git.claim (compare-and-swap)", () => {
  test("two clones racing on the same issue: exactly one wins the push", async () => {
    const root = tmpRoot();
    const { bare, clones } = await bareOriginWithClones(root, ["clone-a", "clone-b"]);
    const git = new Git(new GitCommandRunner());

    const [wonA, wonB] = await Promise.all([git.claim(clones[0]!, 42, "main"), git.claim(clones[1]!, 42, "main")]);
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);

    const branches = await run(["git", "ls-remote", "--heads", bare, "factory/issue-42"], root);
    expect(branches.trim().split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("claiming twice sequentially: the second call loses, it does not silently no-op win", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a", "clone-b"]);
    const git = new Git(new GitCommandRunner());

    expect(await git.claim(clones[0]!, 7, "main")).toBe(true);
    // The old implementation pushed the same base SHA both times, which is a
    // fast-forward no-op — both calls exited 0. This must not happen: B's
    // claim commit descends from base, not from A's now-pushed claim commit,
    // so it cannot fast-forward.
    expect(await git.claim(clones[1]!, 7, "main")).toBe(false);
  });

  test("the claim commit is signed off, so a PR's DCO check passes", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    expect(await new Git(new GitCommandRunner()).claim(clones[0]!, 9, "main")).toBe(true);
    const body = await run(["git", "log", "-1", "--format=%B", "origin/factory/issue-9"], clones[0]!);
    expect(body).toMatch(/^Signed-off-by: .+ <.+>$/m);
  });

  test("claiming against a base that doesn't exist on origin fails cleanly", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    const git = new Git(new GitCommandRunner());
    expect(await git.claim(clones[0]!, 1, "no-such-branch")).toBe(false);
  });
});

describe("Git.commitAll", () => {
  test("commits everything except .factory/runs", async () => {
    const root = tmpRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await initSeededRepo(repo);

    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, ".factory", "runs", "issue-1"), { recursive: true });
    writeFileSync(join(repo, ".factory", "runs", "issue-1", "triage.json"), "{}");

    const git = new Git(new GitCommandRunner());
    expect(await git.commitAll(repo, "factory: build #1")).toBe(true);

    const files = (await run(["git", "show", "--name-only", "--pretty=", "HEAD"], repo)).split("\n").filter(Boolean);
    expect(files).toContain("src/a.ts");
    expect(await run(["git", "log", "-1", "--format=%B"], repo)).toMatch(/^Signed-off-by: .+ <.+>$/m);
    expect(files).not.toContain(".factory/runs/issue-1/triage.json");

    // The runs directory is still on disk for the stage that wrote it — just
    // never committed to the repo history. --untracked-files=all so an
    // untracked dir isn't collapsed to its own line, hiding the path we want.
    const status = await run(["git", "status", "--porcelain", "--untracked-files=all"], repo);
    expect(status).toContain(".factory/runs/issue-1/triage.json");
  });

  test("returns false when the only changes are under .factory/runs", async () => {
    const root = tmpRoot();
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    await initSeededRepo(repo);
    mkdirSync(join(repo, ".factory", "runs", "issue-1"), { recursive: true });
    writeFileSync(join(repo, ".factory", "runs", "issue-1", "x.json"), "{}");

    const git = new Git(new GitCommandRunner());
    expect(await git.commitAll(repo, "factory: build #1")).toBe(false);
  });
});

describe("Git.changedFiles", () => {
  test("reports files changed on the branch versus its base", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    const clone = clones[0]!;
    await run(["git", "checkout", "-b", "factory/issue-5"], clone);
    writeFileSync(join(clone, "src.ts"), "changed\n");
    await run(["git", "add", "-A"], clone);
    await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "change"], clone);

    const git = new Git(new GitCommandRunner());
    expect(await git.changedFiles(clone, "main")).toEqual(["src.ts"]);
  });

  test("reports nothing when the branch hasn't diverged from base", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    const git = new Git(new GitCommandRunner());
    expect(await git.changedFiles(clones[0]!, "main")).toEqual([]);
  });
});

describe("Git.diffStat", () => {
  test("lists both sides of a rename, each file's mode, binaries, and only the given head's diff", async () => {
    const root = tmpRoot();
    const clone = (await bareOriginWithClones(root, ["clone-a"])).clones[0]!;
    const commit = (m: string) =>
      run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", m], clone);
    await run(["git", "checkout", "-b", "factory/issue-6"], clone);
    mkdirSync(join(clone, "moved"));
    await run(["git", "mv", "README.md", "moved/README.md"], clone);
    writeFileSync(join(clone, "run.sh"), "echo hi\n", { mode: 0o755 });
    writeFileSync(join(clone, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
    symlinkSync("moved/README.md", join(clone, "link"));
    await run(["git", "add", "-A"], clone);
    await commit("shape");
    const judged = (await run(["git", "rev-parse", "HEAD"], clone)).trim();
    writeFileSync(join(clone, "later.ts"), "x\n");
    await run(["git", "add", "-A"], clone);
    await commit("after the PR head");

    const files = await new Git(new GitCommandRunner()).diffStat(clone, "main", judged);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["README.md", "link", "logo.bin", "moved/README.md", "run.sh"]);
    expect(byPath["README.md"]!.mode).toBe("000000");
    expect(byPath["moved/README.md"]!.mode).toBe("100644");
    expect(byPath["run.sh"]!.mode).toBe("100755");
    expect(byPath.link!.mode).toBe("120000");
    expect(byPath["logo.bin"]!.binary).toBe(true);
    expect(byPath["run.sh"]!.binary).toBeUndefined();
  });

  test("throws when the head is not in the clone, so the merge fails closed", async () => {
    const root = tmpRoot();
    const clone = (await bareOriginWithClones(root, ["clone-a"])).clones[0]!;
    await expect(new Git(new GitCommandRunner()).diffStat(clone, "main", "0".repeat(40))).rejects.toThrow("git diff");
  });
});

describe("Git.treeHash", () => {
  test("counts uncommitted and untracked edits, ignores .factory/runs, and leaves the real index alone", async () => {
    const root = tmpRoot();
    await initSeededRepo(root);
    const git = new Git(new GitCommandRunner());
    const clean = await git.treeHash(root);
    expect(clean).toBe((await run(["git", "rev-parse", "HEAD^{tree}"], root)).trim());

    writeFileSync(join(root, "README.md"), "edited\n");
    const edited = await git.treeHash(root);
    expect(edited).not.toBe(clean);
    writeFileSync(join(root, "new.txt"), "x\n");
    expect(await git.treeHash(root)).not.toBe(edited);

    mkdirSync(join(root, ".factory/runs/issue-1"), { recursive: true });
    const before = await git.treeHash(root);
    writeFileSync(join(root, ".factory/runs/issue-1/gate.json"), "{}\n");
    expect(await git.treeHash(root)).toBe(before);
    expect((await run(["git", "diff", "--cached", "--name-only"], root)).trim()).toBe("");
  });
});

describe("sparseCheckoutPatterns", () => {
  test("keeps everything, then negates one pattern per holdout path", () => {
    expect(sparseCheckoutPatterns([".factory/holdout/**"])).toEqual(["/*", "!/.factory/holdout/**"]);
    expect(sparseCheckoutPatterns(["a/b", "/c/d"])).toEqual(["/*", "!/a/b", "!/c/d"]);
  });

  test("is a no-op pattern set for no holdout paths", () => {
    expect(sparseCheckoutPatterns([])).toEqual(["/*"]);
  });
});

describe("Git.excludeFromSparseCheckout", () => {
  test("removes a committed holdout path from disk, but leaves it recoverable from history", async () => {
    const root = tmpRoot();
    await initSeededRepo(root);
    mkdirSync(join(root, ".factory", "holdout"), { recursive: true });
    writeFileSync(join(root, ".factory", "holdout", "secret.test.ts"), "the answer is 42\n");
    writeFileSync(join(root, "src.ts"), "kept\n");
    await run(["git", "add", "-A"], root);
    await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "add holdout"], root);

    const git = new Git(new GitCommandRunner());
    await git.excludeFromSparseCheckout(root, [".factory/holdout/**"]);

    // Gone from the working directory, so no agent operating in this worktree
    // can ever read it...
    expect(existsSync(join(root, ".factory", "holdout", "secret.test.ts"))).toBe(false);
    expect(existsSync(join(root, "src.ts"))).toBe(true);
    // ...but still fully present in the commit itself, for the holdout runner
    // to restore from later.
    const fromHistory = await run(["git", "show", "HEAD:.factory/holdout/secret.test.ts"], root);
    expect(fromHistory).toBe("the answer is 42\n");
  });

  test("hidden holdout paths still count as unchanged, so gate evidence matches HEAD's tree", async () => {
    const root = tmpRoot();
    await initSeededRepo(root);
    mkdirSync(join(root, ".factory", "holdout"), { recursive: true });
    writeFileSync(join(root, ".factory", "holdout", "secret.test.ts"), "the answer is 42\n");
    await run(["git", "add", "-A"], root);
    await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "add holdout"], root);

    const git = new Git(new GitCommandRunner());
    await git.excludeFromSparseCheckout(root, [".factory/holdout/**"]);
    expect(await git.treeHash(root)).toBe((await run(["git", "rev-parse", "HEAD^{tree}"], root)).trim());
  });

  test("is a no-op when there are no holdout paths configured", async () => {
    const root = tmpRoot();
    await initSeededRepo(root);
    const git = new Git(new GitCommandRunner());
    await git.excludeFromSparseCheckout(root, []);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    expect(existsSync(join(root, ".git", "info", "sparse-checkout"))).toBe(false);
  });
});

// A repo whose pre-push hook runs the full gate refused every factory push (issue #160).
function failingPrePushHook(clone: string): void {
  writeFileSync(join(clone, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}

describe("factory pushes pass --no-verify through a failing pre-push hook", () => {
  test("claim succeeds through a failing pre-push hook", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    failingPrePushHook(clones[0]!);
    expect(await new Git(new GitCommandRunner()).claim(clones[0]!, 11, "main")).toBe(true);
  });

  test("a branch push succeeds through a failing pre-push hook, and the hook really blocks a plain push", async () => {
    const root = tmpRoot();
    const { clones } = await bareOriginWithClones(root, ["clone-a"]);
    const clone = clones[0]!;
    await run(["git", "checkout", "-b", "factory/issue-12"], clone);
    writeFileSync(join(clone, "src.ts"), "changed\n");
    await run(["git", "add", "-A"], clone);
    await run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-m", "change"], clone);
    failingPrePushHook(clone);

    const plain = await Bun.spawn(["git", "push", "origin", "HEAD:refs/heads/factory/issue-99"], {
      cwd: clone,
      stdout: "pipe",
      stderr: "pipe",
    }).exited;
    expect(plain).not.toBe(0);

    const pushed = await new Git(new GitCommandRunner()).push(clone, 12);
    expect(pushed.code).toBe(0);
  });
});

describe("issueOfPr", () => {
  test("a factory branch names its issue", () => {
    expect(issueOfPr({ headRefName: "factory/issue-42", closingIssuesReferences: [{ number: 7 }] })).toBe(42);
  });
  test("any other PR resolves to the one issue it closes, or to none", () => {
    expect(issueOfPr({ headRefName: "fix-thing", closingIssuesReferences: [{ number: 7 }] })).toBe(7);
    expect(
      issueOfPr({ headRefName: "fix-thing", closingIssuesReferences: [{ number: 7 }, { number: 8 }] }),
    ).toBeUndefined();
    expect(issueOfPr({ headRefName: "factory/issue-42-extra" })).toBeUndefined();
  });
});
