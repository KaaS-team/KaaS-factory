// make check-mutations: every check must bite. Each entry in tests/mutations.json
// breaks one thing in a temp copy of the repo; the named test must then fail.
// A mutation that leaves the test green names a check that guards nothing.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { selectMutations } from "./mutation-select";
import { copyRepo, ROOT } from "./repo-copy";

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly test: string;
  readonly inputs?: readonly string[];
}

const mutations: Mutation[] = JSON.parse(readFileSync(join(ROOT, "tests", "mutations.json"), "utf8"));
const args = process.argv.slice(2);
const flagValue = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const base = flagValue("--base");
const report = flagValue("--report");
const only = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--base" && args[i - 1] !== "--report");

// --bail: one red test already proves the mutant is caught, so the rest of the file need not run.
async function runTest(dir: string, test: string, bail: boolean): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "test", ...(bail ? ["--bail"] : []), test], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

// A test file is run clean once, however many mutations name it.
const cleanRuns = new Map<string, Promise<{ code: number; out: string }>>();
const cleanRun = (dir: string, test: string) => {
  const seen = cleanRuns.get(test) ?? runTest(dir, test, false);
  cleanRuns.set(test, seen);
  return seen;
};

// A worker owns one copy of the repo and puts each file back after its mutation, so the repo is copied once per worker.
async function check(dir: string, m: Mutation): Promise<string | undefined> {
  const path = join(dir, m.file);
  const text = readFileSync(path, "utf8");
  const count = text.split(m.find).length - 1;
  if (count !== 1) return `${m.name}: "find" matches ${count} times in ${m.file}, want exactly 1`;
  const clean = await cleanRun(dir, m.test);
  if (clean.code !== 0) return `${m.name}: ${m.test} fails before the mutation:\n${clean.out.slice(-1500)}`;
  try {
    writeFileSync(path, text.replace(m.find, m.replace));
    const mutant = await runTest(dir, m.test, true);
    if (mutant.code === 0) return `${m.name}: ${m.test} still passes with the mutation, so it guards nothing`;
    console.log(`bites  ${m.name}`);
    return undefined;
  } finally {
    writeFileSync(path, text);
  }
}

const dupe = mutations.find((m, i) => mutations.findIndex((n) => n.name === m.name) !== i);
if (dupe) throw new Error(`tests/mutations.json names "${dupe.name}" twice`);
let selected = only ? mutations.filter((m) => m.name === only) : mutations;
if (base) {
  const diff = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`], { cwd: ROOT });
  if (diff.exitCode !== 0) throw new Error(`git diff ${base}...HEAD failed: ${diff.stderr.toString()}`);
  const baseList = Bun.spawnSync(["git", "show", `${base}:tests/mutations.json`], { cwd: ROOT });
  const before: Mutation[] | undefined = baseList.exitCode === 0 ? JSON.parse(baseList.stdout.toString()) : undefined;
  selected = selectMutations(selected, diff.stdout.toString().split("\n").filter(Boolean), before);
  if (selected.length === 0) {
    console.log(`check-mutations: the diff against ${base} reaches no mutation`);
    process.exit(0);
  }
}
if (selected.length === 0) throw new Error(only ? `no mutation named "${only}"` : "tests/mutations.json is empty");
const failures: string[] = [];
const failedNames: string[] = [];
const queue = [...selected];
const workers = Math.min(Number(process.env.MUTATION_WORKERS) || availableParallelism(), queue.length);
await Promise.all(
  Array.from({ length: workers }, async () => {
    const dir = copyRepo();
    try {
      for (let m = queue.shift(); m; m = queue.shift()) {
        const problem = await check(dir, m);
        if (problem) {
          failures.push(problem);
          failedNames.push(m.name);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);
if (report) {
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ selected: selected.map((m) => m.name), failed: failedNames }, null, 2));
}
if (failures.length) {
  console.error(`\ncheck-mutations: ${failures.length} of ${selected.length} failed\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`check-mutations: all ${selected.length} mutations bite`);
