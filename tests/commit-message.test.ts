// Fake build: real commits through commitByTask, then the log is read back.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCommitMessage } from "../src/commit-message";
import { commitByTask } from "../src/engine/epic";
import { Git, GitCommandRunner } from "../src/git";

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

function repo(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-cm-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

const CONVENTIONAL = /^(feat|fix|chore|docs|refactor|test)(\([a-z0-9._/-]+\))?: .+ \(#122\)$/;
const RUNNER_ID = /runner-\d|-\d{10,}/;

describe("factory commit messages", () => {
  test("a fake build with two tasks gives conventional titles, a why, Closes and a sign-off", async () => {
    const dir = repo();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "export.ts"), "a");
    writeFileSync(join(dir, "src", "cli.ts"), "b");
    await commitByTask(new Git(new GitCommandRunner()), dir, {
      tasks: [
        { id: "T1", title: "Export runs as JSONL", files: ["src/export.ts"] },
        { id: "T2", title: "Add the export flag", files: ["src/cli.ts"] },
      ],
      goal: "Operators need a machine readable record of runs. JSONL streams well.",
      type: "feat",
      ref: "#122",
      title: "Export runs",
      files: ["src/export.ts", "src/cli.ts"],
    });
    const subjects = git(dir, "log", "--format=%s", "HEAD~2..HEAD").trim().split("\n");
    expect(subjects).toHaveLength(2);
    for (const s of subjects) {
      expect(s).toMatch(/^feat\(.+\): .+/);
      expect(RUNNER_ID.test(s)).toBe(false);
    }
    const bodies = git(dir, "log", "-2", "--format=%b%x00")
      .split("\0")
      .map((b) => b.trim())
      .filter(Boolean);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b).toContain("Operators need a machine readable record of runs.");
      expect(b).toMatch(/^Signed-off-by: .+ <.+>$/m);
    }
    // Newest first: the last commit closes, the earlier task commit only refers.
    expect(bodies[0]).toMatch(/^Closes #122$/m);
    expect(bodies[1]).toMatch(/^Refs #122$/m);
    expect(bodies[1]).not.toContain("Closes");
  });

  test("the why is the Problem paragraph capped at three sentences, not the whole goal", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "a");
    await commitByTask(new Git(new GitCommandRunner()), dir, {
      tasks: [],
      goal: "Goal one. Goal two. Goal three. Goal four.",
      problem: "## Problem\nFirst. Second. Third. Fourth. Fifth.\n\n## Wanted\nOther text.",
      type: "feat",
      ref: "#122",
      title: "Export runs",
      files: ["a.ts"],
    });
    const body = git(dir, "log", "-1", "--format=%b").trim();
    expect(body).toContain("First. Second. Third.");
    expect(body).not.toContain("Fourth");
    expect(body).not.toContain("Goal");
    expect(body).not.toContain("Other text");
  });

  test("without a Problem paragraph the goal is the why, capped at three sentences", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "a");
    await commitByTask(new Git(new GitCommandRunner()), dir, {
      tasks: [],
      goal: "Goal one. Goal two. Goal three. Goal four.",
      type: "feat",
      ref: "#122",
      title: "Export runs",
      files: ["a.ts"],
    });
    const body = git(dir, "log", "-1", "--format=%b").trim();
    expect(body).toContain("Goal one. Goal two. Goal three.");
    expect(body).not.toContain("Goal four");
  });

  test("task commits use their own task text, not the shared goal title", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "a");
    writeFileSync(join(dir, "b.ts"), "b");
    await commitByTask(new Git(new GitCommandRunner()), dir, {
      tasks: [
        { id: "T1", title: "Write the parser", files: ["a.ts"] },
        { id: "T2", title: "Wire the flag", files: ["b.ts"] },
      ],
      goal: "Runs need exporting.",
      type: "feat",
      ref: "#122",
      title: "Export runs",
      files: ["a.ts", "b.ts"],
    });
    const body = git(dir, "log", "-2", "--format=%b%x00");
    expect(body).toContain("Task T1 of #122.");
    expect(body).toContain("Task T2 of #122.");
  });

  test("the claim commit pushed by Git.claim has a plain title, the marker, and no Closes", async () => {
    const origin = repo();
    git(origin, "config", "receive.denyCurrentBranch", "ignore");
    mkdirSync(tmpdir(), { recursive: true });
    const clone = mkdtempSync(join(tmpdir(), "factory-cm-clone-"));
    roots.push(clone);
    git(clone, "init", "-q", "-b", "main");
    git(clone, "remote", "add", "origin", origin);
    expect(await new Git(new GitCommandRunner()).claim(clone, 122, "main")).toBe(true);
    const msg = git(origin, "log", "-1", "--format=%B", "factory/issue-122");
    expect(msg.split("\n")[0]).toBe("chore(factory): claim issue #122 for the factory");
    expect(msg).toMatch(/^Factory-Claim: #122 runner .+$/m);
    expect(msg).not.toMatch(/Closes/);
  });

  test("a single-task build title matches the conventional form with the issue at the end", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.ts"), "a");
    await commitByTask(new Git(new GitCommandRunner()), dir, {
      tasks: [],
      goal: "Runs need exporting.",
      type: "feat",
      ref: "#122",
      title: "Export runs as JSONL",
      files: ["a.ts"],
    });
    expect(git(dir, "log", "-1", "--format=%s").trim()).toMatch(CONVENTIONAL);
  });

  test("the claim title has no runner id, the marker and runner id stay in the body", () => {
    const msg = claimCommitMessage(122, "runner-10289-1793103791470");
    const [title = "", , ...rest] = msg.split("\n");
    expect(RUNNER_ID.test(title)).toBe(false);
    expect(title).toBe("chore(factory): claim issue #122 for the factory");
    expect(rest.join("\n")).toContain("Factory-Claim: #122 runner runner-10289-1793103791470");
  });
});
