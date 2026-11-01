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
      expect(b).toMatch(/^Closes #122$/m);
      expect(b).toMatch(/^Signed-off-by: .+ <.+>$/m);
    }
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
