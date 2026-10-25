// template/.factory/mutate.sh: how verify checks a "removing X makes the tests fail" criterion
// (#42). kaas-suite card 15 parked twice because verify's Edit on the worktree was denied, so
// the script runs the mutation on a throwaway copy and the worktree it judges never changes.
// It runs repo code, so what it runs is fixed by the script and config, never by the caller.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_PATH } from "../src/proof";

const SCRIPT = join(import.meta.dir, "..", "template", ".factory", "mutate.sh");
const GUARD = '[ "$1" != evil ]';
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

// A repo whose test checks a guard, reads an ignored dependency the copy must carry, and
// writes into that dependency dir, which must never reach the worktree's own.
function fixture(gateCmd = "bash", fileCmd?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mutate-fixture-"));
  dirs.push(dir);
  for (const d of [".factory", "src", "tests", "node_modules"]) mkdirSync(join(dir, d));
  copyFileSync(SCRIPT, join(dir, ".factory", "mutate.sh"));
  const config = {
    gates: [{ name: "test", cmd: gateCmd, ...(fileCmd ? { fileCmd } : {}), required: true, role: "test" }],
    protectedPaths: ["secret/**"],
  };
  writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify(config));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.factory/runs/\n");
  writeFileSync(join(dir, "node_modules", "dep.sh"), "dep_ok() { true; }\n");
  writeFileSync(join(dir, "src", "guard.sh"), `guard() { ${GUARD}; }\nlabel() { echo "guarded"; }\n`);
  writeFileSync(join(dir, "src", "guard.config.sh"), "x=1\n");
  writeFileSync(join(dir, "src", "boot.sh"), "ready=1\nflag=true\n");
  writeFileSync(
    join(dir, "tests", "check.sh"),
    'source node_modules/dep.sh && dep_ok || { echo "dependency missing"; exit 3; }\nsource src/boot.sh\n[ "$ready" = 1 ] || { echo "boot error"; exit 2; }\necho run >> node_modules/written.txt\necho "secret=${FAKE_SECRET:-unset}"\nsource src/guard.sh\nif guard evil; then echo "1 failed"; exit 1; fi\necho "0 failed"\n',
  );
  // What the copy looks like from inside a test: its history, its common git dir (how kaas-suite
  // finds a sibling kaas.team checkout) and whether its temp dir sits inside the repo.
  writeFileSync(
    join(dir, "tests", "env.sh"),
    'echo "commits=$(git rev-list --count HEAD 2>/dev/null || echo 0)"\necho "common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo /nowhere)" 2>/dev/null && pwd -P)"\ncase "$(cd "$TMPDIR" && pwd -P)" in "$(pwd -P)"/*) echo tmp=inside;; *) echo tmp=outside;; esac\necho "0 failed"\n',
  );
  git(dir, "init", "-q");
  // Background gc or maintenance would touch .git while the tree is hashed.
  git(dir, "config", "gc.auto", "0");
  git(dir, "config", "maintenance.auto", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture");
  return dir;
}

// Every file under the repo, .git and node_modules included, by path and content.
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      h.update(p.slice(dir.length));
      if (lstatSync(p).isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

function mutate(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(["bash", ".factory/mutate.sh", ...args], {
    cwd: dir,
    env: { ...process.env, FAKE_SECRET: "s3cret", GH_TOKEN: "t0ken" },
  });
  const out = r.stdout.toString();
  return { code: r.exitCode, out, line: out.trim().split("\n").at(-1) ?? "" };
}

describe("mutate.sh", () => {
  test("reports bites when the replacement breaks a test; the worktree, node_modules included, stays byte-identical", () => {
    const dir = fixture();
    const before = treeHash(dir);
    const r = mutate(dir, "src/guard.sh", GUARD, "true", "tests/check.sh");
    expect(r.line).toBe("MUTATION: file=src/guard.sh status=bites failed=1");
    expect(r.code).toBe(0);
    // The parent's variables (tokens included) never reach the repo's code.
    expect(r.out).toContain("secret=unset");
    expect(r.out).not.toContain("s3cret");
    expect(existsSync(join(dir, "node_modules", "written.txt"))).toBe(false);
    expect(treeHash(dir)).toBe(before);
  });

  test("reports survives when the replacement breaks nothing the test checks", () => {
    const dir = fixture();
    const before = treeHash(dir);
    const r = mutate(dir, "src/guard.sh", 'echo "guarded"', "true", "tests/check.sh");
    expect(r.line).toBe("MUTATION: file=src/guard.sh status=survives failed=0");
    expect(r.code).toBe(1);
    expect(treeHash(dir)).toBe(before);
  });

  test("records the result in proof.json when asked", () => {
    const dir = fixture();
    mkdirSync(join(dir, ".factory", "runs", "issue-7"), { recursive: true });
    writeFileSync(join(dir, ".factory", "runs", "issue-7", "proof.json"), JSON.stringify({ status: "skipped" }));
    const r = mutate(
      dir,
      "--proof",
      ".factory/runs/issue-7/proof.json",
      "src/guard.sh",
      GUARD,
      "true",
      "tests/check.sh",
    );
    expect(r.code).toBe(0);
    const proof = JSON.parse(readFileSync(join(dir, ".factory", "runs", "issue-7", "proof.json"), "utf8"));
    expect(proof.status).toBe("skipped");
    expect(proof.mutations).toHaveLength(1);
    expect(proof.mutations[0]).toMatchObject({
      file: "src/guard.sh",
      status: "bites",
      failed: "1",
      cmd: "bash tests/check.sh",
      exitCode: 1,
    });
  });

  test("an absent search text exits non-zero", () => {
    const r = mutate(fixture(), "src/guard.sh", "no such text", "true", "tests/check.sh");
    expect([r.code, r.line]).toEqual([2, "MUTATION: file=src/guard.sh status=error failed=0 reason=search-absent"]);
  });

  test("an ambiguous search text exits non-zero", () => {
    const r = mutate(fixture(), "src/guard.sh", "() {", "true", "tests/check.sh");
    expect([r.code, r.line]).toEqual([2, "MUTATION: file=src/guard.sh status=error failed=0 reason=search-ambiguous"]);
  });

  test("tests already red on the unmutated copy are an error, not bites", () => {
    const dir = fixture();
    writeFileSync(join(dir, "src", "guard.sh"), "guard() { true; }\nlabel() { :; }\n");
    git(dir, "commit", "-qam", "break the guard");
    const r = mutate(dir, "src/guard.sh", ":;", "true", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "baseline-red"]);
  });

  // Fails closed: none of these may read as a caught mutation.
  test("a test runner that cannot start is an error, not bites", () => {
    const r = mutate(fixture("no-such-test-runner-xyz"), "src/guard.sh", GUARD, "true", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "no-test-runner"]);
  });

  test("a runner found but not executable (exit 126 or 127) is an error, not bites", () => {
    const r = mutate(fixture("sh -c"), "src/guard.sh", GUARD, "true", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "runner-failed"]);
  });

  test("a mutated run that crashes with no failed test is an error, not bites", () => {
    const r = mutate(fixture(), "src/boot.sh", "ready=1", "0", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "no-test-failed"]);
  });

  test("a replacement equal to the search text is an error, not survives", () => {
    const r = mutate(fixture(), "src/boot.sh", "true", "true", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "replace-is-noop"]);
  });

  // Each refusal names its reason and runs nothing: no file appears in the worktree.
  const refused: [string, string[], string][] = [
    ["a free-form command as the test", ["src/guard.sh", GUARD, "true", "touch pwned"], "not-in-head"],
    ["an untracked path as the test", ["src/guard.sh", GUARD, "true", "pwned"], "not-in-head"],
    ["a tracked non-test as the test", ["src/guard.sh", GUARD, "true", "src/guard.config.sh"], "not-a-test"],
    ["a test file as the target", ["tests/check.sh", "guard evil", "true", "tests/check.sh"], "target-is-test"],
    ["a .factory file as the target", [".factory/mutate.sh", "set -u", "true", "tests/check.sh"], "target-off-limits"],
    ["a *.config.* file as the target", ["src/guard.config.sh", "x=1", "0", "tests/check.sh"], "target-off-limits"],
    ["a .. path as the target", ["src/../src/guard.sh", GUARD, "true", "tests/check.sh"], "bad-path"],
    ["an absolute path as the target", ["/etc/hosts", "localhost", "0", "tests/check.sh"], "bad-path"],
    ["a .. path as the test", ["src/guard.sh", GUARD, "true", "tests/../tests/check.sh"], "bad-path"],
    [
      "a replacement that adds code",
      ["src/guard.sh", GUARD, 'require("child_process").execSync("touch pwned")', "tests/check.sh"],
      "replace-not-allowed",
    ],
    [
      "a replacement that rewrites the line",
      ["src/guard.sh", GUARD, "touch pwned", "tests/check.sh"],
      "replace-not-allowed",
    ],
    [
      "a proof path outside the run dir",
      ["--proof", "src/guard.sh", "src/guard.sh", GUARD, "true", "tests/check.sh"],
      "bad-proof-path",
    ],
  ];
  for (const [name, args, reason] of refused)
    test(`refuses ${name}`, () => {
      const dir = fixture();
      const before = treeHash(dir);
      const r = mutate(dir, ...args);
      expect([r.code, r.line.split("reason=")[1]]).toEqual([2, reason]);
      expect(treeHash(dir)).toBe(before);
    });

  test("accepts the operator mutations: one ! added or removed, one comparison swapped", () => {
    const dir = fixture();
    for (const replace of ['[ "$1" !!= evil ]', '[ "$1" = evil ]'])
      expect(mutate(dir, "src/guard.sh", GUARD, replace, "tests/check.sh").line).not.toContain("replace-not-allowed");
    writeFileSync(join(dir, "src", "cmp.sh"), "a === b; c < d\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "cmp");
    for (const replace of ["a !== b; c < d", "a === b; c >= d"])
      expect(mutate(dir, "src/cmp.sh", "a === b; c < d", replace, "tests/check.sh").line).toContain("status=survives");
    expect(mutate(dir, "src/cmp.sh", "a === b; c < d", "a !== b; c >= d", "tests/check.sh").line).toContain(
      "replace-not-allowed",
    );
  });

  test("refuses a test gate that is not one plain command", () => {
    const r = mutate(fixture("bash tests/check.sh; touch pwned"), "src/guard.sh", GUARD, "true", "tests/check.sh");
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "no-test-runner"]);
  });

  // kaas-suite cards 33 to 36: a git archive copy had no history and no common git dir, and its
  // TMPDIR sat inside the copy, so 5 tests failed before any mutation (baseline-red every time).
  test("the copy is a git checkout of HEAD with history and the worktree's common dir, TMPDIR outside it, and leaves nothing registered", () => {
    const dir = fixture();
    const before = treeHash(dir);
    const r = mutate(dir, "src/guard.sh", 'echo "guarded"', "true", "tests/env.sh");
    expect(r.line).toBe("MUTATION: file=src/guard.sh status=survives failed=0");
    expect(r.out).toContain("commits=1");
    expect(r.out).toContain(`common=${realpathSync(join(dir, ".git"))}`);
    expect(r.out).toContain("tmp=outside");
    const list = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], { cwd: dir }).stdout.toString();
    expect(list.match(/^worktree /gm)).toHaveLength(1);
    expect(treeHash(dir)).toBe(before);
  });

  test("runs the test gate's fileCmd with the named tests when it has one", () => {
    const dir = fixture("no-such-whole-suite-runner", "bash");
    mkdirSync(join(dir, ".factory", "runs", "issue-7"), { recursive: true });
    const r = mutate(
      dir,
      "--proof",
      ".factory/runs/issue-7/proof.json",
      "src/guard.sh",
      GUARD,
      "true",
      "tests/check.sh",
    );
    expect([r.code, r.line]).toEqual([0, "MUTATION: file=src/guard.sh status=bites failed=1"]);
    const proof = JSON.parse(readFileSync(join(dir, ".factory", "runs", "issue-7", "proof.json"), "utf8"));
    expect(proof.mutations[0].cmd).toBe("bash tests/check.sh");
  });

  test("refuses a fileCmd that is not one plain command", () => {
    const r = mutate(
      fixture("bash", "bash tests/check.sh; touch pwned"),
      "src/guard.sh",
      GUARD,
      "true",
      "tests/check.sh",
    );
    expect([r.code, r.line.split("reason=")[1]]).toEqual([2, "no-test-runner"]);
  });

  test("knows the same test paths as the runner's proof", () => {
    const text = readFileSync(SCRIPT, "utf8");
    for (const re of TEST_PATH) expect(text).toContain(`r"${re.source.replace(/\\\//g, "/")}"`);
  });
});
