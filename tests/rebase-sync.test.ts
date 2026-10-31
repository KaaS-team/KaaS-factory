import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebaseOnBase } from "../src/merge-autonomy";
import { mergeBaseline, mergeMutationList, pick3 } from "../src/rebase-sync";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
async function clone(root: string, name: string, remote: string): Promise<string> {
  const dir = join(root, name);
  await git(root, "clone", "-q", remote, dir);
  await git(dir, "config", "user.email", "t@example.com");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "commit.gpgsign", "false");
  return dir;
}
const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;
const entry = (name: string) => JSON.stringify({ name, file: "f", find: "a", replace: "b", test: "t" });
const list = (...names: string[]) => `[\n${names.map((n) => `  ${entry(n)}`).join(",\n")}\n]\n`;
const baseline = (a: number, b: number) =>
  `${JSON.stringify({ comments: {}, lines: { "a.ts": a, "b.ts": b }, names: {}, exclude: [] }, null, 2)}\n`;
const put = async (dir: string, file: string, text: string, msg: string) => {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", msg);
};

async function twoBranches(conflictC = false) {
  const root = mkdtempSync(join(tmpdir(), "rebase-sync-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = await clone(root, "seed", remote);
  await git(seed, "checkout", "-q", "-b", "main");
  writeFileSync(join(seed, "a.ts"), lines(401));
  writeFileSync(join(seed, "b.ts"), lines(401));
  writeFileSync(join(seed, "c.txt"), "base\n");
  writeFileSync(join(seed, "quality-baseline.json"), baseline(401, 401));
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  const work = await clone(root, "work", remote);
  await git(work, "checkout", "-q", "-b", "feature");
  await put(work, "a.ts", lines(402), "feature a");
  if (conflictC) await put(work, "c.txt", "feature\n", "feature c");
  await git(work, "push", "-q", "origin", "feature");
  await put(seed, "b.ts", lines(405), "main b");
  if (conflictC) await put(seed, "c.txt", "main\n", "main c");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  return { work };
}

test("branches that each append a mutation and move a line cap rebase with both", async () => {
  const root = mkdtempSync(join(tmpdir(), "rebase-sync-"));
  roots.push(root);
  const remote = join(root, "remote.git");
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  const seed = await clone(root, "seed", remote);
  await git(seed, "checkout", "-q", "-b", "main");
  const mk = async (dir: string, a: number, b: number, names: string[]) => {
    writeFileSync(join(dir, "a.ts"), lines(a));
    writeFileSync(join(dir, "b.ts"), lines(b));
    writeFileSync(join(dir, "quality-baseline.json"), baseline(a, b));
    require("node:fs").mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests/mutations.json"), list(...names));
  };
  await mk(seed, 401, 401, ["Base"]);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "base");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  const work = await clone(root, "work", remote);
  await git(work, "checkout", "-q", "-b", "feature");
  await mk(work, 402, 401, ["Base", "X"]);
  await git(work, "add", "-A");
  await git(work, "commit", "-q", "-m", "feature");
  await git(work, "push", "-q", "origin", "feature");
  await mk(seed, 401, 405, ["Base", "Y"]);
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "main");
  await git(seed, "push", "-q", "origin", "HEAD:main");

  const head = await rebaseOnBase(work, "main", "feature");
  expect(await git(remote, "rev-parse", "feature")).toBe(head);
  const base = JSON.parse(readFileSync(join(work, "quality-baseline.json"), "utf8"));
  expect(base.lines).toEqual({ "a.ts": 402, "b.ts": 405 });
  const names = (JSON.parse(readFileSync(join(work, "tests/mutations.json"), "utf8")) as { name: string }[]).map(
    (m) => m.name,
  );
  expect(names).toEqual(["Base", "Y", "X"]);
  for (const f of ["quality-baseline.json", "tests/mutations.json"])
    expect(readFileSync(join(work, f), "utf8")).not.toContain("<<<<<<<");
  expect(existsSync(join(work, await git(work, "rev-parse", "--git-path", "rebase-merge")))).toBe(false);
});

test("a conflict in another file still fails the rebase", async () => {
  const { work } = await twoBranches(true);
  const before = await git(work, "rev-parse", "HEAD");
  await expect(rebaseOnBase(work, "main", "feature")).rejects.toThrow();
  expect(await git(work, "rev-parse", "HEAD")).toBe(before);
  expect(existsSync(join(work, await git(work, "rev-parse", "--git-path", "rebase-merge")))).toBe(false);
});

test("pick3 gives up when both sides changed one key differently", () => {
  expect(pick3("a", "b", "c")).toBeUndefined();
  expect(pick3("a", "c", "c")).toEqual({ value: "a" });
  expect(pick3("c", "b", "c")).toEqual({ value: "b" });
});

test("mergeMutationList conflicts on a doubly edited name and drops a deleted one", () => {
  const edited = (n: string, t: string) => JSON.stringify({ name: n, file: "f", find: "a", replace: "b", test: t });
  const wrap = (...rows: string[]) => `[\n${rows.map((r) => `  ${r}`).join(",\n")}\n]\n`;
  const base = wrap(edited("A", "t0"), edited("B", "t0"));
  expect(
    mergeMutationList(wrap(edited("A", "t1"), edited("B", "t0")), wrap(edited("A", "t2"), edited("B", "t0")), base),
  ).toBeUndefined();
  const merged = mergeMutationList(wrap(edited("A", "t0")), wrap(edited("A", "t0"), edited("B", "t0")), base);
  expect(merged).toBe(wrap(edited("A", "t0")));
});

test("mergeBaseline drops a line cap whose file is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rebase-sync-"));
  roots.push(dir);
  writeFileSync(join(dir, "a.ts"), lines(3));
  const out = mergeBaseline(baseline(401, 401), baseline(402, 401), baseline(401, 401), dir);
  expect(JSON.parse(out!).lines).toEqual({ "a.ts": 3 });
});
