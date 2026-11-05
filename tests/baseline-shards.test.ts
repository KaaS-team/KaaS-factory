import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Baseline, readBaseline, writeBaseline } from "../src/baseline-shards";
import { parseLog, rankHotspots } from "../src/hotspots";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "shards-"));
  roots.push(d);
  return d;
};

const seed: Baseline = {
  metrics: { lines: { "src/a.ts": 410, "src/z.ts": 450 }, comments: { "src/a.ts": 1 } },
};

test("a baseline survives a write and a read", () => {
  const dir = tmp();
  writeBaseline(seed, join(dir, "quality-baseline"));
  expect(readBaseline(dir)).toEqual(seed);
});

test("writing drops the shard of an entry that left the baseline", () => {
  const dir = tmp();
  const out = join(dir, "quality-baseline");
  writeBaseline(seed, out);
  writeBaseline({ ...seed, metrics: { lines: { "src/a.ts": 410 } } }, out);
  expect(readBaseline(dir).metrics).toEqual({ lines: { "src/a.ts": 410 } });
});

test("two branches that each add a baseline entry merge with no conflict", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  writeBaseline(seed, join(dir, "quality-baseline"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  const add = (branch: string, file: string, max: number) => {
    git(dir, "checkout", "-q", "-b", branch, "main");
    const b = readBaseline(dir);
    b.metrics.lines![file] = max;
    writeBaseline(b, join(dir, "quality-baseline"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", branch);
  };
  add("one", "src/b.ts", 401);
  add("two", "src/c.ts", 402);
  git(dir, "checkout", "-q", "one");
  const merged = git(dir, "merge", "--no-edit", "two");
  expect(merged.code).toBe(0);
  expect(merged.out).not.toContain("CONFLICT");
  expect(readBaseline(dir).metrics.lines).toEqual({
    "src/a.ts": 410,
    "src/b.ts": 401,
    "src/c.ts": 402,
    "src/z.ts": 450,
  });
});

test("rankHotspots counts distinct PRs, most first, and marks listed shared files", () => {
  const changes = [
    { pr: "1", files: ["Makefile", "a.ts"] },
    { pr: "2", files: ["Makefile", "a.ts", "b.ts"] },
    { pr: "3", files: ["Makefile"] },
    { pr: "3", files: ["Makefile"] },
  ];
  expect(rankHotspots(changes)).toEqual([
    { file: "Makefile", prs: 3, shared: true },
    { file: "a.ts", prs: 2, shared: false },
  ]);
});

test("parseLog reads one change per squash-merge commit and skips the rest", () => {
  const log = "\u0001feat: x (#12)\n\na.ts\nb.ts\n\u0001wip with no number\nc.ts\n\u0001fix: y (#13)\n\na.ts\n";
  expect(parseLog(log)).toEqual([
    { pr: "12", files: ["a.ts", "b.ts"] },
    { pr: "13", files: ["a.ts"] },
  ]);
});

test("factory hotspots lists the files several merged PRs changed", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  for (const [n, files] of [
    [1, ["hot.ts", "a.ts"]],
    [2, ["hot.ts", "b.ts"]],
    [3, ["hot.ts"]],
  ] as const) {
    for (const f of files) writeFileSync(join(dir, f), `${n}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `change ${n} (#${n})`);
  }
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "hotspots", "--json"], { cwd: dir, env });
  const out = JSON.parse(p.stdout.toString()).data;
  expect(out.hotspots).toEqual([{ file: "hot.ts", prs: 3, shared: false }]);
});

// The vendored check-quality.py must keep skipping this repo, or a kit sync turns on a second ratchet.
test("the vendored check-quality defers to this ratchet through the exclude-only marker", () => {
  const marker = JSON.parse(readFileSync(join(import.meta.dir, "..", "quality-baseline.json"), "utf8"));
  expect(Object.keys(marker)).toEqual(["exclude"]);
  const p = Bun.spawnSync(["python3", "scripts/kaas/check-quality.py"], { cwd: join(import.meta.dir, "..") });
  expect(p.stdout.toString()).toContain("belongs to another ratchet");
  expect(p.exitCode).toBe(0);
});
