import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

export const compiledPython = (paths: readonly string[]): string[] =>
  paths.filter((p) => p.endsWith(".pyc") || p.split("/").includes("__pycache__"));

test("the matcher flags compiled Python paths and nothing else", () => {
  const sample = ["scripts/__pycache__/x.cpython-313.pyc", "a/b.pyc", "__pycache__/c.txt", "scripts/ok.py"];
  expect(compiledPython(sample)).toEqual(sample.slice(0, 3));
});

// The check scripts write scripts/__pycache__, so .gitignore keeps a session from committing it.
test(".gitignore ignores __pycache__ and .pyc", () => {
  const lines = readFileSync(join(root, ".gitignore"), "utf8").split("\n");
  expect(lines).toContain("__pycache__/");
  expect(lines).toContain("*.pyc");
});

// A mutation copy has no .git, so the tracked-file walk only runs in a real checkout.
test("git ls-files lists no .pyc and no __pycache__ path", () => {
  if (!existsSync(join(root, ".git"))) return;
  const out = Bun.spawnSync(["git", "ls-files"], { cwd: root });
  expect(out.exitCode).toBe(0);
  expect(compiledPython(out.stdout.toString().split("\n").filter(Boolean))).toEqual([]);
});
