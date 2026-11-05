import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (f: string): string => readFileSync(join(root, f), "utf8");
const tracked = new TextDecoder()
  .decode(Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout)
  .split("\n")
  .filter((f) => f && existsSync(join(root, f)));
const makeText = [read("Makefile"), ...readdirSync(join(root, "make")).map((f) => read(`make/${f}`))].join("\n");

// `make check` runs `make test`, which runs bare `bun test`: it finds every bun test file under the
// repo root, skipping node_modules and dot directories. This pins each link of that chain.
describe("make check reaches every test file", () => {
  test("check depends on test", () => {
    const line = read("Makefile")
      .split("\n")
      .find((l) => l.startsWith("check:"));
    expect(line?.slice("check:".length).trim().split(/\s+/)).toContain("test");
  });

  test("the test recipe runs bun test with no path filter", () => {
    const recipe = read("Makefile")
      .split("\n")
      .find((l) => l.includes("-- bun test"));
    expect(recipe).toContain("bun test -t");
    const after = recipe!.split("-- bun test")[1]!.split("||")[0]!;
    const words = after.trim().split(/\s+/);
    const paths = words.filter((w) => w.endsWith(".ts") || w.startsWith("tests") || w.startsWith("./"));
    expect(paths).toEqual([]);
  });

  test("bunfig narrows nothing", () => {
    expect(read("bunfig.toml")).not.toMatch(/pathIgnorePatterns|^\s*root\s*=/m);
  });

  test("no bun test file sits where bun test does not look", () => {
    const hidden = tracked.filter(
      (f) =>
        /(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(f) &&
        f.split("/").some((p) => p.startsWith(".") || p === "node_modules"),
    );
    expect(hidden).toEqual([]);
  });

  test("a rust, python or go test is run by a make target", () => {
    const foreign: [RegExp, RegExp][] = [
      [/\.rs$/, /cargo test/],
      [/(^|\/)test_[^/]*\.py$|_test\.py$/, /pytest|unittest/],
      [/_test\.go$/, /go test/],
    ];
    const unreached = tracked.filter((f) => {
      if (f.startsWith("tests/fixtures/")) return false;
      return foreign.some(([file, runner]) => {
        if (!file.test(f) || runner.test(makeText)) return false;
        return file === foreign[0]![0] ? /#\[test\]/.test(read(f)) : true;
      });
    });
    expect(unreached).toEqual([]);
  });
});
