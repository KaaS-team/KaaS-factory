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

function childRun(cmd: string[], env: Record<string, string>): { code: number; left: string[] } {
  const outer = mkdtempSync(join(tmpdir(), "temp-leak-"));
  try {
    const tmp = join(outer, "tmp");
    mkdirSync(tmp);
    const file = join(outer, "leaky.test.ts");
    writeFileSync(file, LEAKY);
    const res = Bun.spawnSync(
      cmd.map((c) => c.replace("<file>", file)),
      { cwd: repoRoot, env: { ...process.env, ...env, TMPDIR: tmp } },
    );
    return { code: res.exitCode, left: readdirSync(tmp) };
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}

test("bun test removes the temp dirs a test made and never cleaned", () => {
  expect(childRun(["bun", "test", "<file>"], {})).toEqual({ code: 0, left: [] });
});

test("make test removes temp files a child process made outside the test's own process", () => {
  expect(childRun(["make", "-s", "test", "FILES=<file>"], { LEAK_SHELL: "1" })).toEqual({ code: 0, left: [] });
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
