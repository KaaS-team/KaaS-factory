// The goals ledger: every ask, in the asker's words, with the proof that it is done.
// Why: deferrals lived only in CHANGELOG prose and came back after compaction as paraphrase, so
// planned work was dropped silently. A goal is done only when its proof passes; the first red row is next.
//
//   bun scripts/goals.ts                  lint (also run by tests/goals.test.ts, so in make check)
//   bun scripts/goals.ts --run [--phase P2] [--ids a,b]   run every proof, print red or green
//   bun scripts/goals.ts --next           the first goal with no proof yet (the SessionStart hook)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TestProof {
  readonly test: string;
  readonly name: string;
  readonly mutation: string;
}
export interface ProbeProof {
  readonly probe: string;
}
export type Proof = TestProof | ProbeProof;

export interface Goal {
  readonly id: string;
  readonly phase: string;
  readonly ask: string;
  readonly source: string;
  readonly owner: "agent" | "param";
  readonly proof?: Proof;
  readonly out?: { readonly by: "param"; readonly quote: string; readonly date: string };
}
export interface Phase {
  readonly id: string;
  readonly title: string;
  readonly release?: string;
}
export interface Ledger {
  readonly phases: readonly Phase[];
  readonly goals: readonly Goal[];
}

export interface Repo {
  readonly read: (path: string) => string | undefined;
  readonly version: string;
  readonly mutations: readonly { readonly name: string; readonly test: string }[];
}

const ROOT = join(import.meta.dir, "..");

export function repoAt(root: string): Repo {
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined);
  return {
    read,
    version: (JSON.parse(read("package.json") ?? "{}") as { version: string }).version,
    mutations: JSON.parse(read("tests/mutations.json") ?? "[]"),
  };
}

const cmp = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x![i] !== y![i]) return x![i]! - y![i]!;
  return 0;
};

// A probe that only checks a file exists, prints --help, or echoes and exits proves nothing; v5.0.0
// had rows green on `--help` and rows that were `echo ... exit 1` stubs.
// `true`, `:` and `|| true` make any probe pass, so they count as no check at all.
const WEAK_LINE = /^\s*(#.*|test -[fed] \S+|\[ -[fed] \S+ \]|echo .*|exit \d+|set -\w+|true|:|)\s*$/;
export function weakProbe(body: string): string | undefined {
  if (/--help\b/.test(body)) return "calls --help";
  if (/\|\|\s*(true|:)\s*(;|$)/m.test(body)) return "swallows a failure with || true";
  const lines = body.split("\n").filter((l) => !l.startsWith("#!"));
  if (lines.every((l) => WEAK_LINE.test(l))) return "only checks existence or echoes";
  return undefined;
}

// Bullets under "Not in this release" for versions after the ledger landed must name their goal.
const LEDGER_SINCE = "5.0.0";
export function untrackedDeferrals(changelog: string, ids: ReadonlySet<string>): string[] {
  const errs: string[] = [];
  for (const section of changelog.split(/^## /m).slice(1)) {
    const version = /^v(\d+\.\d+\.\d+)/.exec(section)?.[1];
    if (!version || cmp(version, LEDGER_SINCE) <= 0) continue;
    const at = section.indexOf("Not in this release");
    if (at === -1) continue;
    for (const bullet of section
      .slice(at)
      .split(/\n(?=- )/)
      .slice(1)) {
      const id = /\(goal: ([\w-]+)\)/.exec(bullet)?.[1];
      if (!id) errs.push(`CHANGELOG v${version}: deferral names no goal: ${bullet.split("\n")[0]}`);
      else if (!ids.has(id)) errs.push(`CHANGELOG v${version}: goal ${id} is not in goals.json`);
    }
  }
  return errs;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A name in a comment or inside another string is not a test; the call itself must open with it.
export function declaresTest(body: string, name: string): boolean {
  return new RegExp(`(^|\\n)\\s*(test|it)(\\.\\w+)?\\(\\s*(["'\`])${literal(name)}\\4`).test(body);
}

export function lint(doc: Ledger, repo: Repo): string[] {
  const errs: string[] = [];
  const phases = new Map(doc.phases.map((p) => [p.id, p]));
  const ids = new Set<string>();
  const mutations = new Map(repo.mutations.map((m) => [m.name, m.test]));
  for (const g of doc.goals) {
    const at = `goal ${g.id ?? "?"}`;
    if (!g.id || ids.has(g.id)) errs.push(`${at}: missing or duplicate id`);
    ids.add(g.id);
    const phase = phases.get(g.phase);
    if (!phase) errs.push(`${at}: phase ${g.phase} is not in phases`);
    if (!g.ask?.trim()) errs.push(`${at}: no ask`);
    if (!g.source?.trim()) errs.push(`${at}: no source`);
    if (g.owner !== "agent" && g.owner !== "param") errs.push(`${at}: owner must be agent or param`);
    // Only the user drops scope, in their own words.
    if (g.out && (g.out.by !== "param" || !g.out.quote?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(g.out.date ?? "")))
      errs.push(`${at}: out needs {by: "param", quote, date}`);
    const p = g.proof;
    if (p && "test" in p) {
      const body = repo.read(p.test);
      if (!body) errs.push(`${at}: ${p.test} does not exist`);
      else if (!declaresTest(body, p.name)) errs.push(`${at}: no test named ${JSON.stringify(p.name)} in ${p.test}`);
      if (mutations.get(p.mutation) !== p.test)
        errs.push(`${at}: mutation ${JSON.stringify(p.mutation)} is not in tests/mutations.json for ${p.test}`);
    } else if (p && "probe" in p) {
      const body = repo.read(p.probe);
      if (!/^scripts\/probes\/[\w-]+\.sh$/.test(p.probe)) errs.push(`${at}: a probe is scripts/probes/<name>.sh`);
      if (!body) errs.push(`${at}: ${p.probe} does not exist`);
      else {
        const weak = weakProbe(body);
        if (weak) errs.push(`${at}: probe ${p.probe} ${weak}`);
      }
    } else if (p) errs.push(`${at}: a proof is {test, name, mutation} or {probe}`);
    // The release gate: a version cannot ship while a goal of its phase has no proof.
    if (phase?.release && cmp(repo.version, phase.release) >= 0 && !p && !g.out)
      errs.push(`${at}: v${repo.version} includes phase ${phase.id}, but this goal has no proof`);
  }
  for (const p of doc.phases) if (!doc.goals.some((g) => g.phase === p.id)) errs.push(`phase ${p.id} has no goal`);
  errs.push(...untrackedDeferrals(repo.read("CHANGELOG.md") ?? "", ids));
  return errs;
}

// --next needs no test run: CI runs every test on each push, so a goal with a proof is green on main.
export function next(doc: Ledger): Goal | undefined {
  for (const p of doc.phases) {
    const g = doc.goals.find((x) => x.phase === p.id && !x.proof && !x.out);
    if (g) return g;
  }
  return undefined;
}

function prove(p: Proof): boolean {
  const argv =
    "test" in p ? ["bun", "test", p.test, "-t", `^${literal(p.name)}$|${literal(p.name)}$`] : ["bash", p.probe];
  return Bun.spawnSync(argv, { cwd: ROOT, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

function run(doc: Ledger, phase?: string, only?: ReadonlySet<string>): number {
  let red = 0;
  let first: Goal | undefined;
  for (const p of doc.phases.filter((x) => !phase || x.id === phase)) {
    const goals = doc.goals.filter((g) => g.phase === p.id && (!only || only.has(g.id)));
    if (goals.length === 0) continue;
    console.log(`\n${p.id}  ${p.title}`);
    for (const g of goals) {
      const state = g.out ? "out  " : !g.proof ? "red  " : prove(g.proof) ? "green" : "red  ";
      if (state === "red  ") {
        red++;
        first ??= g;
      }
      const why = !g.proof && !g.out ? "  (not built)" : "";
      console.log(`  ${state}  ${g.id}${g.owner === "param" ? "  [needs Param]" : ""}${why}`);
    }
  }
  console.log(`\ngoals: ${red} red${first ? `; next: ${first.id} (${first.phase})` : ""}`);
  return red ? 1 : 0;
}

if (import.meta.main) {
  const doc = JSON.parse(readFileSync(join(ROOT, "goals.json"), "utf8")) as Ledger;
  const errs = lint(doc, repoAt(ROOT));
  if (errs.length) {
    console.error(`goals: ${errs.length} problems in goals.json\n${errs.map((e) => `  ${e}`).join("\n")}`);
    process.exit(1);
  }
  const arg = (flag: string) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  if (process.argv.includes("--next")) {
    const g = next(doc);
    console.log(g ? `Next goal: ${g.id} (${g.phase}): ${g.ask}` : "Every goal has a proof.");
  } else if (process.argv.includes("--run")) {
    const ids = arg("--ids");
    process.exit(run(doc, arg("--phase"), ids ? new Set(ids.split(",")) : undefined));
  } else console.log(`goals: ok, ${doc.goals.length} goals across ${doc.phases.length} phases`);
}
