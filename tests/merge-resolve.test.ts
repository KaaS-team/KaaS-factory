import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRun, resolveConflicts } from "../src/merge-resolve";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...a: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

function conflicted(file: string): string {
  mkdirSync(tmpdir(), { recursive: true }); // the preload removes the root after each rerun
  const dir = mkdtempSync(join(tmpdir(), "mr-"));
  git(dir, "init", "-q", "-b", "main");
  const put = (text: string) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", text);
  };
  put("base\n");
  git(dir, "checkout", "-q", "-b", "br");
  put("branch\n");
  git(dir, "checkout", "-q", "main");
  put("main\n");
  git(dir, "merge", "br");
  return dir;
}

test("quality-baseline.json takes main's side and runs the regenerate cmd", () => {
  const dir = conflicted("quality-baseline.json");
  const calls: string[] = [];
  const run = (cwd: string, argv: string[]) => {
    calls.push(argv.join(" "));
    return defaultRun(cwd, argv[0] === "bash" ? ["true"] : argv);
  };
  const r = resolveConflicts(dir, run);
  expect(r).toEqual({ resolved: ["quality-baseline.json"], unresolved: [] });
  expect(readFileSync(join(dir, "quality-baseline.json"), "utf8")).toBe("main\n");
  expect(calls.some((c) => c.includes("bun scripts/gen-quality-baseline.ts"))).toBe(true);
});

test("tests/mutation-list.test.ts takes main's side", () => {
  const dir = conflicted("tests/mutation-list.test.ts");
  const r = resolveConflicts(dir);
  expect(r.resolved).toEqual(["tests/mutation-list.test.ts"]);
  expect(readFileSync(join(dir, "tests/mutation-list.test.ts"), "utf8")).toBe("main\n");
});

test("an unlisted file stays unresolved with its markers", () => {
  const dir = conflicted("src/a.ts");
  const r = resolveConflicts(dir);
  expect(r).toEqual({ resolved: [], unresolved: ["src/a.ts"] });
  expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("<<<<<<<");
});
