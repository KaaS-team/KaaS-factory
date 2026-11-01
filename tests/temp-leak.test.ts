// A run's temp files must not outlive it (#270). The fixture below leaks on purpose; each test runs it in a child.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LEAKY = `import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("leaks", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-a37-"));
  writeFileSync(join(dir, "f"), "x");
  if (process.env.LEAK_SHELL) Bun.spawnSync(["sh", "-c", "mktemp \\"\${TMPDIR:-/tmp}/factory-gate.XXXXXX\\""]);
  expect(process.env.LEAK_FAIL).toBeUndefined();
});
`;

const repoRoot = resolve(import.meta.dir, "..");

function childRun(cmd: string[], env: Record<string, string>): { code: number; left: string[]; out: string } {
  // preload's afterAll removes the run root after each --rerun-each repeat; recreate it so a repeat never needs the last one's dir.
  mkdirSync(tmpdir(), { recursive: true });
  const outer = mkdtempSync(join(tmpdir(), "temp-leak-"));
  try {
    const tmp = join(outer, "tmp");
    mkdirSync(tmp);
    const file = join(outer, "leaky.test.ts");
    writeFileSync(file, LEAKY);
    // check-cache lists inputs with `git ls-files`, which fails where the repo is a copy with no .git (a mutant under /tmp).
    // Point git at a throwaway dir for the work tree so the child behaves the same wherever the repo sits.
    const gitDir = join(outer, "git");
    const init = Bun.spawnSync(["git", "init", "-q", gitDir], { env: { ...process.env, TMPDIR: tmp } });
    if (init.exitCode !== 0) throw new Error(`git init: ${init.stderr}`);
    // A mutant's node_modules is a symlink, which .gitignore's `node_modules/` does not match, and git cannot hash it.
    mkdirSync(join(gitDir, ".git", "info"), { recursive: true });
    writeFileSync(join(gitDir, ".git", "info", "exclude"), "node_modules\nreports\n");
    // `make test TEST_ARGS=...` exports TEST_ARGS and MAKEFLAGS; a child inheriting --rerun-each repeats the
    // fixture after the preload removed its root. Each child runs once.
    const { MAKEFLAGS: _m, MFLAGS: _f, TEST_ARGS: _t, ...base } = process.env;
    const res = Bun.spawnSync(
      cmd.map((c) => c.replace("<file>", file)),
      {
        cwd: repoRoot,
        env: {
          ...base,
          ...env,
          TMPDIR: tmp,
          GIT_DIR: join(gitDir, ".git"),
          GIT_WORK_TREE: repoRoot,
          CHECK_CACHE_DIR: join(outer, "cache"),
        },
      },
    );
    const out = `${res.stdout}`.slice(-1500) + `\n--stderr--\n${res.stderr}`.slice(-1500);
    return { code: res.exitCode, left: readdirSync(tmp), out };
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

test("bun test removes the temp dirs a test made and never cleaned", () => {
  const r = childRun(["bun", "test", "<file>"], {});
  expect({ code: r.code, left: r.left }, r.out).toEqual({ code: 0, left: [] });
});

test("make test removes temp files a child process made outside the test's own process", () => {
  const r = childRun(["make", "-s", "test", "FILES=<file>"], { LEAK_SHELL: "1" });
  expect({ code: r.code, left: r.left }, r.out).toEqual({ code: 0, left: [] });
});

test("make test still fails when a test fails, and still cleans up", () => {
  const r = childRun(["make", "-s", "test", "FILES=<file>"], { LEAK_SHELL: "1", LEAK_FAIL: "1" });
  expect(r.code).not.toBe(0);
  expect(r.left).toEqual([]);
});

test("a test sees a temp dir under its run's own root, and FACTORY_HOME inside it", () => {
  expect(
    tmpdir()
      .split("/")
      .some((seg) => seg.startsWith("factory-test-")),
  ).toBe(true);
  expect(process.env.FACTORY_HOME?.startsWith(tmpdir())).toBe(true);
});
