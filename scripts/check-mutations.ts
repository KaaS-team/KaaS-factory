// make check-mutations: every check must bite. Each entry in tests/mutations.json
// breaks one thing in a temp copy of the repo; the named test must then fail.
// A mutation that leaves the test green names a check that guards nothing.

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly test: string;
}

const ROOT = join(import.meta.dir, "..");
const SKIP = new Set(["node_modules", ".git", ".worktrees", ".factory-state", "workspaces", "artifacts"]);
const mutations: Mutation[] = JSON.parse(readFileSync(join(ROOT, "tests", "mutations.json"), "utf8"));
const only = process.argv[2];

function copyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-mutant-"));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !SKIP.has(src.slice(ROOT.length + 1).split("/")[0]!) });
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

async function runTest(dir: string, test: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "test", test], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

async function check(m: Mutation): Promise<string | undefined> {
  const dir = copyRepo();
  try {
    const path = join(dir, m.file);
    const text = readFileSync(path, "utf8");
    const count = text.split(m.find).length - 1;
    if (count !== 1) return `${m.name}: "find" matches ${count} times in ${m.file}, want exactly 1`;
    const clean = await runTest(dir, m.test);
    if (clean.code !== 0) return `${m.name}: ${m.test} fails before the mutation:\n${clean.out.slice(-1500)}`;
    writeFileSync(path, text.replace(m.find, m.replace));
    const mutant = await runTest(dir, m.test);
    if (mutant.code === 0) return `${m.name}: ${m.test} still passes with the mutation, so it guards nothing`;
    console.log(`bites  ${m.name}`);
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dupe = mutations.find((m, i) => mutations.findIndex((n) => n.name === m.name) !== i);
if (dupe) throw new Error(`tests/mutations.json names "${dupe.name}" twice`);
const selected = only ? mutations.filter((m) => m.name === only) : mutations;
if (selected.length === 0) throw new Error(only ? `no mutation named "${only}"` : "tests/mutations.json is empty");
const failures: string[] = [];
for (let i = 0; i < selected.length; i += 4) {
  for (const problem of await Promise.all(selected.slice(i, i + 4).map(check))) if (problem) failures.push(problem);
}
if (failures.length) {
  console.error(`\ncheck-mutations: ${failures.length} of ${selected.length} failed\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`check-mutations: all ${selected.length} mutations bite`);
