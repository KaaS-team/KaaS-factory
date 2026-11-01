import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP, parseArgs, prune, runCached } from "../scripts/check-cache";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
let repo = "";
let store = "";
let counter = "";

function git(...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo,
    env: { ...process.env, ...GIT_ENV },
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}

function runs(): number {
  return existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0;
}

function go(opts: { argv?: string[]; env?: Record<string, string | undefined> } = {}) {
  const argv = opts.argv ?? [
    "bash",
    "-c",
    `echo run >> ${counter}; mkdir -p out; echo result > out/result.txt; echo hello`,
  ];
  return runCached({
    root: repo,
    name: "demo",
    ins: [],
    outs: ["out/result.txt"],
    argv,
    env: { CHECK_CACHE_DIR: store, ...opts.env },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "check-cache-repo-"));
  store = mkdtempSync(join(tmpdir(), "check-cache-store-"));
  counter = join(mkdtempSync(join(tmpdir(), "check-cache-count-")), "n");
  git("init", "-q");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "init");
});

afterEach(() => {
  for (const d of [repo, store]) rmSync(d, { recursive: true, force: true });
});

describe("check-cache", () => {
  test("the first run misses and the second replays it", async () => {
    expect(await go()).toBe(0);
    expect(runs()).toBe(1);
    rmSync(join(repo, "out"), { recursive: true });
    expect(await go()).toBe(0);
    expect(runs()).toBe(1);
    expect(readFileSync(join(repo, "out/result.txt"), "utf8")).toBe("result\n");
  });

  test("editing a tracked file misses", async () => {
    await go();
    writeFileSync(join(repo, "a.txt"), "two\n");
    await go();
    expect(runs()).toBe(2);
  });

  test("an untracked, not ignored new file misses", async () => {
    await go();
    writeFileSync(join(repo, "new.txt"), "x\n");
    await go();
    expect(runs()).toBe(2);
  });

  test("a failing command is not stored and runs again", async () => {
    const argv = ["bash", "-c", `echo run >> ${counter}; exit 3`];
    expect(await go({ argv })).toBe(3);
    expect(await go({ argv })).toBe(3);
    expect(runs()).toBe(2);
  });

  test("--rerun-each and CHECK_CACHE=off always run", async () => {
    const rerun = ["bash", "-c", `echo run >> ${counter}`, "--rerun-each", "3"];
    await go({ argv: rerun });
    await go({ argv: rerun });
    expect(runs()).toBe(2);
    await go({ env: { CHECK_CACHE: "off" } });
    await go({ env: { CHECK_CACHE: "off" } });
    expect(runs()).toBe(4);
  });

  test("hits and misses are appended to the step summary", async () => {
    const summary = join(store, "summary.md");
    await go({ env: { GITHUB_STEP_SUMMARY: summary } });
    await go({ env: { GITHUB_STEP_SUMMARY: summary } });
    const lines = readFileSync(summary, "utf8").split("\n").filter(Boolean);
    expect(lines.map((l) => l.replace(/ [0-9a-f]{12}$/, ""))).toEqual([
      "- check-cache: miss demo",
      "- check-cache: hit demo",
    ]);
  });

  test("prune keeps the newest KEEP", () => {
    for (let i = 0; i < KEEP + 3; i += 1) {
      const f = join(store, `demo-${i}.json`);
      writeFileSync(f, "{}");
      utimesSync(f, 1000 + i, 1000 + i);
    }
    writeFileSync(join(store, "other-1.json"), "{}");
    prune(store, "demo");
    const kept = [...Array(KEEP + 3).keys()].filter((i) => existsSync(join(store, `demo-${i}.json`)));
    expect(kept).toEqual([3, 4, 5, 6, 7]);
    expect(existsSync(join(store, "other-1.json"))).toBe(true);
  });

  test("parseArgs splits at the first -- and rejects a bad name", () => {
    expect(parseArgs(["t", "--in", "verify", "--out", "r.xml", "--", "bun", "test", "--", "x"])).toEqual({
      name: "t",
      ins: ["verify"],
      outs: ["r.xml"],
      argv: ["bun", "test", "--", "x"],
    });
    expect(parseArgs(["Bad_Name", "--", "ls"])).toBeUndefined();
    expect(parseArgs(["ok", "ls"])).toBeUndefined();
  });
});

describe("the gate runs through the cache", () => {
  const root = join(import.meta.dir, "..");
  const make = readFileSync(join(root, "Makefile"), "utf8");
  const recipe = (name: string) => make.split(new RegExp(`^${name}:.*$`, "m"))[1]?.split(/\n\n/)[0] ?? "";

  test("lint, typecheck and test recipes use $(CACHE)", () => {
    expect(make).toContain("CACHE = bun scripts/check-cache.ts");
    expect(recipe("typecheck")).toContain("$(CACHE) typecheck -- bun x tsc --noEmit");
    expect(recipe("test")).toContain("$(CACHE) test --out reports/junit.xml -- bun test");
    const lint = recipe("lint")
      .split("\n")
      .filter((l) => /^\t(bun x biome|uvx reuse|cargo (fmt|clippy))/.test(l));
    expect(lint).toEqual([]);
    expect(recipe("lint").match(/^\t\$\(CACHE\) /gm)?.length).toBe(6);
  });

  test("CI restores and saves reports/check-cache", () => {
    const wf = [join(root, ".github/workflows/ci.yml"), join(root, "ci/ci.yml")]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n");
    expect(wf).toContain("actions/cache/restore@v4");
    expect(wf).toContain("actions/cache/save@v4");
    expect(wf.match(/path: reports\/check-cache/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
