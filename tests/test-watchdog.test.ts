import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHung, hungLine } from "../scripts/test-watchdog";

const ROOT = join(import.meta.dir, "..");

function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "watchdog-"));
}

describe("test watchdog", () => {
  test("a marker older than the limit is hung, a younger one is not", () => {
    const dir = tmp();
    writeFileSync(join(dir, "11.json"), JSON.stringify({ file: "/r/tests/a.test.ts", name: "slow", start: 1_000 }));
    writeFileSync(join(dir, "12.json"), JSON.stringify({ file: "/r/tests/b.test.ts", name: "fresh", start: 9_000 }));
    expect(findHung(dir, 11_000, 5_000)).toEqual([{ pid: 11, file: "/r/tests/a.test.ts", name: "slow", seconds: 10 }]);
  });

  test("the line names the file, the test, how long it ran and the limit", () => {
    const h = { pid: 1, file: "/r/tests/a.test.ts", name: "slow", seconds: 12 };
    expect(hungLine(h, 5, "/r")).toBe("HUNG: tests/a.test.ts > slow ran 12s, over the 5s limit; killed");
  });

  test("a deliberate hang is killed and named, with a non-zero exit", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "hang.test.ts"),
      `import { test } from "bun:test";\ntest("deliberate hang", () => { const end = Date.now() + 60000; while (Date.now() < end); });\n`,
    );
    const { MAKEFLAGS: _m, MFLAGS: _f, TEST_ARGS: _t, ...env } = process.env;
    const p = Bun.spawnSync(
      [
        "bun",
        join(ROOT, "scripts", "test-watchdog.ts"),
        "--limit",
        "1",
        "--",
        "bun",
        "test",
        "--preload",
        join(ROOT, "scripts", "test-hang-marker.ts"),
        join(dir, "hang.test.ts"),
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(p.stderr.toString()).toMatch(/HUNG: .*hang\.test\.ts > deliberate hang ran \d+s, over the 1s limit; killed/);
    expect(p.exitCode).toBe(124);
  }, 30_000);

  test("make test has one hang limit and runs bun through the watchdog", () => {
    const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
    expect(mk.match(/^TEST_HANG_LIMIT \?= \d+$/gm)?.length).toBe(1);
    expect(mk).toContain("bun scripts/test-watchdog.ts --limit $(TEST_HANG_LIMIT) -- $(CACHE) test");
    expect(mk).toContain("--preload ./scripts/test-hang-marker.ts");
  });
});
