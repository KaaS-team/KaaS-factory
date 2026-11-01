import { expect, test } from "bun:test";

const root = new URL("..", import.meta.url).pathname;

export const compiledPython = (paths: readonly string[]): string[] =>
  paths.filter((p) => p.endsWith(".pyc") || p.split("/").includes("__pycache__"));

test("the matcher flags compiled Python paths and nothing else", () => {
  const sample = ["scripts/__pycache__/x.cpython-313.pyc", "a/b.pyc", "__pycache__/c.txt", "scripts/ok.py"];
  expect(compiledPython(sample)).toEqual(sample.slice(0, 3));
});

test("git ls-files lists no .pyc and no __pycache__ path", () => {
  const out = Bun.spawnSync(["git", "ls-files"], { cwd: root });
  expect(out.exitCode).toBe(0);
  expect(compiledPython(out.stdout.toString().split("\n").filter(Boolean))).toEqual([]);
});
