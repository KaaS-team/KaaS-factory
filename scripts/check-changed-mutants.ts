// One mutant per changed source line on a pull request, and only the tests that import the file run.
// A mutant that every covering test still passes is a line nothing checks.
// A line whose mutant is equivalent carries a `mutant-ok: <why>` comment.

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { type Mutant, mutantsFor } from "../src/changed-mutants";
import { coveringTests, testFiles } from "./import-graph";
import { copyRepo, ROOT } from "./repo-copy";

export const MAX_PR_MUTANTS = 30;
export const MAX_COVERING = 5;

export const inScope = (file: string): boolean =>
  /^(src|scripts|dashboard)\/.*\.ts$/.test(file) && !file.startsWith("scripts/kaas/") && !file.includes("/fixtures/");

export const prMutants = (diff: string, read: (file: string) => string): Mutant[] =>
  mutantsFor(diff, read)
    .filter((m) => inScope(m.file) && !m.before.includes("mutant-ok:"))
    .slice(0, MAX_PR_MUTANTS);

export type Outcome = "killed" | "survived" | "uncovered";
export interface Result {
  mutant: Mutant;
  outcome: Outcome;
  tests: string[];
}

export async function runMutant(dir: string, m: Mutant, tests: string[]): Promise<Outcome> {
  const path = join(dir, m.file);
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  lines[m.line - 1] = m.after;
  let code: number;
  try {
    writeFileSync(path, lines.join("\n"));
    const proc = Bun.spawn(["bun", "test", "--bail", ...tests], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    code = await proc.exited;
  } finally {
    writeFileSync(path, original);
  }
  return code === 0 ? "survived" : "killed";
}

export function summary(results: readonly Result[]): string {
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  const head = `check-changed-mutants: ${count("killed")} killed, ${count("survived")} survived, ${count("uncovered")} uncovered`;
  const rows = results.map((r) => `| ${r.mutant.file}:${r.mutant.line} | ${r.outcome} | ${r.tests.join(", ")} |`);
  return [head, "", "| Line | Outcome | Tests |", "| --- | --- | --- |", ...rows, ""].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const base = args[args.indexOf("--base") + 1];
  if (args.indexOf("--base") < 0 || !base) {
    console.error("usage: bun scripts/check-changed-mutants.ts --base <ref>");
    process.exit(2);
  }
  const git = Bun.spawnSync(["git", "diff", "--unified=0", "--no-color", `${base}...HEAD`], { cwd: ROOT });
  if (git.exitCode !== 0) throw new Error(`git diff ${base}...HEAD failed: ${git.stderr.toString()}`);
  const mutants = prMutants(git.stdout.toString(), (f) => readFileSync(join(ROOT, f), "utf8"));
  if (!mutants.length) {
    console.log("check-changed-mutants: no changed source line to mutate");
    process.exit(0);
  }
  const all = testFiles(ROOT);
  const results: Result[] = mutants.map((mutant) => ({
    mutant,
    outcome: "uncovered",
    tests: coveringTests(mutant.file, all, ROOT).slice(0, MAX_COVERING),
  }));
  const covered = results.filter((r) => r.tests.length > 0);
  const workers = Math.min(Number(process.env.MUTATION_WORKERS) || availableParallelism(), covered.length);
  if (covered.length) {
    const queue = [...covered];
    let broken = false;
    await Promise.all(
      Array.from({ length: workers }, async (_, i) => {
        const dir = copyRepo(ROOT, "factory-pr-mutant-");
        try {
          if (i === 0) {
            const union = [...new Set(covered.flatMap((r) => r.tests))];
            const clean = Bun.spawn(["bun", "test", ...union], { cwd: dir, stdout: "ignore", stderr: "ignore" });
            if ((await clean.exited) !== 0) broken = true;
          }
          for (let r = queue.shift(); r && !broken; r = queue.shift())
            r.outcome = await runMutant(dir, r.mutant, r.tests);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
    );
    if (broken) {
      console.error("check-changed-mutants: covering tests fail before any mutation");
      process.exit(1);
    }
  }
  for (const r of results) {
    const label = r.outcome === "survived" ? "SURVIVED" : r.outcome;
    console.log(`${label}  ${r.mutant.file}:${r.mutant.line}  ${r.tests.join(" ")}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(results));
  const survived = results.filter((r) => r.outcome === "survived").length;
  if (survived) {
    console.error(
      `check-changed-mutants: ${survived} of ${results.length} mutants survived: a changed line no test checks. Add a test, or mark an equivalent mutant with a "mutant-ok: <why>" comment on that line.`,
    );
    process.exit(1);
  }
}
