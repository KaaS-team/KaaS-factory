import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAP, report, reportWithLog, summarize, unfinished } from "../scripts/test-failures";

const wrap = (cases: string): string =>
  `<?xml version="1.0"?>\n<testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;
const ok = (name: string): string => `<testcase name="${name}" file="tests/a.test.ts" />`;
const bad = (name: string, message: string): string =>
  `<testcase name="${name}" file="tests/a.test.ts"><failure type="Error" message="${message}">trace</failure></testcase>`;

function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "test-failures-"));
}

describe("test failures summary", () => {
  test("no failures says so and counts the tests", () => {
    expect(summarize(wrap(ok("one") + ok("two")))).toBe("no failing tests (2 ran)");
  });

  test("two failures list name and first message line", () => {
    const xml = wrap(bad("first &lt;x&gt;", "boom&#10;second line") + ok("fine") + bad("second", "nope"));
    expect(summarize(xml)).toBe(
      ["FAILED tests/a.test.ts > first <x>", "  boom", "FAILED tests/a.test.ts > second", "  nope"].join("\n"),
    );
  });

  test("more than the cap is cut with a count", () => {
    const xml = wrap(Array.from({ length: CAP + 5 }, (_, i) => bad(`t${i}`, "m")).join(""));
    const lines = summarize(xml).split("\n");
    expect(lines.filter((l) => l.startsWith("FAILED ")).length).toBe(CAP);
    expect(lines[lines.length - 1]).toBe("and 5 more");
  });

  test("malformed xml reports no testcases and does not throw", () => {
    expect(summarize("<testsuites><testcase")).toBe("no testcases found in the junit report");
  });

  test("missing file prints the one-line notice", () => {
    const path = join(tmp(), "absent.xml");
    expect(report(path)).toBe(`no junit report at ${path}; the test step ended before writing one`);
  });

  test("empty file prints the one-line notice", () => {
    const path = join(tmp(), "empty.xml");
    writeFileSync(path, "");
    expect(report(path)).toBe(`no junit report at ${path}; the test step ended before writing one`);
  });

  test("step summary is appended only when a path is given", () => {
    const dir = tmp();
    const junit = join(dir, "j.xml");
    const summary = join(dir, "summary.md");
    writeFileSync(junit, wrap(bad("x", "m")));
    report(junit, undefined);
    expect(() => readFileSync(summary, "utf8")).toThrow();
    const text = report(junit, summary);
    expect(readFileSync(summary, "utf8")).toBe(`### Failing tests\n\n\`\`\`\n${text}\n\`\`\`\n`);
  });

  test("the CLI reads GITHUB_STEP_SUMMARY and exits 0 for a missing report", () => {
    const dir = tmp();
    const summary = join(dir, "s.md");
    const withVar = Bun.spawnSync(["bun", "scripts/test-failures.ts", join(dir, "none.xml")], {
      timeout: 60_000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(withVar.exitCode).toBe(0);
    expect(readFileSync(summary, "utf8").includes("no junit report at")).toBe(true);
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    const without = Bun.spawnSync(["bun", "scripts/test-failures.ts", join(dir, "none.xml")], { timeout: 60_000, env });
    expect(without.exitCode).toBe(0);
    expect(without.stdout.toString().includes("no junit report at")).toBe(true);
  });
  test("make test names the failing tests when the run fails", () => {
    const mk = readFileSync(join(import.meta.dir, "..", "Makefile"), "utf8");
    expect(mk.includes("bun scripts/test-failures.ts reports/junit.xml")).toBe(true);
  });

  test("a file the log started but junit lacks is unfinished", () => {
    const log = ["tests/a.test.ts:", "  ok", "tests/b.test.ts:", "  hang"].join("\n");
    expect(unfinished(log, ["tests/a.test.ts"])).toEqual(["tests/b.test.ts"]);
  });

  test("a missing report names the last started file", () => {
    const dir = tmp();
    const logPath = join(dir, "run.log");
    const missingPath = join(dir, "none.xml");
    writeFileSync(logPath, "tests/a.test.ts:\ntests/b.test.ts:\n");
    expect(reportWithLog(missingPath, logPath)).toContain("last test file started: tests/b.test.ts");
  });

  test("a failed test step with no failing test says so and names the last file started", () => {
    const dir = tmp();
    const j = join(dir, "j.xml");
    const logPath = join(dir, "run.log");
    writeFileSync(j, wrap(ok("one")));
    writeFileSync(logPath, "tests/a.test.ts:\nmake: *** [Makefile:40: test] Error 137\n");
    const out = reportWithLog(j, logPath);
    expect(out).toContain(
      "test step exited non-zero (Error 137) and no test failed; last test file started: tests/a.test.ts",
    );
  });

  test("a log with no failed test step adds no abort line", () => {
    const dir = tmp();
    const j = join(dir, "j.xml");
    const logPath = join(dir, "run.log");
    writeFileSync(j, wrap(ok("one")));
    writeFileSync(logPath, "tests/a.test.ts:\nmake: *** [Makefile:30: lint] Error 1\n");
    expect(reportWithLog(j, logPath)).not.toContain("no test failed");
  });

  test("no log keeps the old output", () => {
    const dir = tmp();
    const p = join(dir, "j.xml");
    writeFileSync(p, wrap(ok("one")));
    expect(reportWithLog(p, undefined)).toBe(report(p));
  });
});
