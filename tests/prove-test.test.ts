// The prove-test step (#510): the implementation is reverted in a scratch worktree, the new test
// must fail there, and the result reaches the verify comment.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdictPost } from "../src/engine/verdict-rules";
import { runProof, ShellProofGit } from "../src/proof";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(args: string[], cwd: string): string {
  const r = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
  return r.stdout.toString();
}

function repo(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const origin = mkdtempSync(join(tmpdir(), "prove-origin-"));
  const work = mkdtempSync(join(tmpdir(), "prove-work-"));
  dirs.push(origin, work);
  sh(["git", "init", "-q", "--bare", "-b", "main"], origin);
  sh(["git", "init", "-q", "-b", "main"], work);
  writeFileSync(join(work, "impl.txt"), "old\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "-q", "-m", "base"], work);
  sh(["git", "remote", "add", "origin", origin], work);
  sh(["git", "push", "-q", "origin", "main"], work);
  sh(["git", "checkout", "-q", "-b", "factory/issue-1"], work);
  writeFileSync(join(work, "impl.txt"), "new\n");
  mkdirSync(join(work, "tests"));
  writeFileSync(join(work, "tests/a.test.ts"), "// t\n");
  sh(["git", "add", "-A"], work);
  sh(["git", "commit", "-q", "-m", "build"], work);
  return work;
}

test("the revert runs in a scratch worktree and the build's worktree is never touched", async () => {
  const work = repo();
  // The command records where it ran and whether the implementation was reverted there.
  const cmd = `pwd > "${work}/ran-in.txt"; grep -q new impl.txt && echo "1 pass"`;
  const r = await runProof(new ShellProofGit(), work, "main", "test", cmd);
  expect(r.status).toBe("bites");
  expect(readFileSync(join(work, "ran-in.txt"), "utf8").trim()).not.toBe(work);
  expect(readFileSync(join(work, "impl.txt"), "utf8")).toBe("new\n");
  expect(sh(["git", "worktree", "list"], work).trim().split("\n")).toHaveLength(1);
  expect(existsSync(readFileSync(join(work, "ran-in.txt"), "utf8").trim())).toBe(false);
});

test("the step fails when the new test still passes with the implementation reverted", async () => {
  const work = repo();
  const r = await runProof(new ShellProofGit(), work, "main", "test", "echo '1 pass'");
  expect(r.status).toBe("passes-without");
  expect(r.reverted).toEqual(["impl.txt"]);
});

test("the verify comment carries the proof result", () => {
  const proof = { status: "bites", reverted: ["impl.txt"], tests: ["tests/a.test.ts"], cmd: "x", tail: "" } as never;
  const verdict = { result: "pass", rounds: 1, findings: [] } as never;
  const out = verdictPost("## Verdict: pass\n\nok", verdict, 1, 3, proof);
  expect(out).toContain("### Proof");
  expect(out).toContain("the new test fails without the change");
  expect(out).toContain("`impl.txt`");
  expect(verdictPost("ok", verdict, 1, 3)).not.toContain("### Proof");
});

test("without a scratch checkout the revert runs in place and HEAD comes back exactly", async () => {
  const work = repo();
  const inPlace = Object.assign(Object.create(new ShellProofGit()), { scratch: undefined }) as ShellProofGit;
  const r = await runProof(inPlace, work, "main", "test", "echo '1 pass'");
  expect(r.status).toBe("passes-without");
  expect(readFileSync(join(work, "impl.txt"), "utf8")).toBe("new\n");
  expect(sh(["git", "status", "--porcelain"], work)).toBe("");
});
