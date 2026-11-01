// A selector miss is a mutation that failed in the full run on main that the PR selection for the same diff
// would not have run; the miss rate says whether the selection can be trusted.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { importClosure } from "./import-graph";
import { type Scoped, selectMutations } from "./mutation-select";
import { ROOT } from "./repo-copy";

export interface MissRow {
  at: string;
  sha: string;
  before: string;
  failed: number;
  misses: string[];
}

export function selectorMisses<T extends Scoped & { name: string }>(
  all: readonly T[],
  failed: readonly string[],
  changed: readonly string[],
  before?: readonly T[],
): string[] {
  const picked = new Set(selectMutations(all, changed, before).map((m) => m.name));
  return failed.filter((name) => !picked.has(name));
}

export function suggestedInputs(test: string, changed: readonly string[], root: string): string[] {
  const closure = importClosure(test, root);
  const inside = changed.filter((f) => f !== test && closure.has(f));
  return inside.length ? inside : changed.slice(0, 10);
}

export const missTitle = (name: string): string => `Selector miss: ${name}`;

export function missBody(
  m: { name: string; test: string },
  sha: string,
  changed: readonly string[],
  inputs: readonly string[],
): string {
  return [
    `The full run on main at ${sha} failed \`${m.name}\`, but the PR selection for the same diff would not have run it.`,
    "",
    "Changed files:",
    ...changed.map((f) => `- \`${f}\``),
    "",
    `Add this line to the entry in \`tests/mutations.json\` so the selection runs it next time:`,
    "",
    "```",
    `"inputs": [${inputs.map((f) => JSON.stringify(f)).join(", ")}]`,
    "```",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flagValue = (flag: string) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
  const before = flagValue("--before");
  const reportPath = flagValue("--report");
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: ROOT });
  if (!reportPath || !existsSync(reportPath)) {
    console.log("selector-misses: no mutation report to compare");
    process.exit(0);
  }
  if (!before || /^0+$/.test(before)) {
    console.log("selector-misses: no earlier commit to compare against");
    process.exit(0);
  }
  type Entry = Scoped & { name: string };
  const all: Entry[] = JSON.parse(readFileSync(join(ROOT, "tests", "mutations.json"), "utf8"));
  const old = git("show", `${before}:tests/mutations.json`);
  const baseList: Entry[] | undefined = old.exitCode === 0 ? JSON.parse(old.stdout.toString()) : undefined;
  const changed = git("diff", "--name-only", `${before}...HEAD`).stdout.toString().split("\n").filter(Boolean);
  const sha = git("rev-parse", "HEAD").stdout.toString().trim();
  const failed: string[] = JSON.parse(readFileSync(reportPath, "utf8")).failed ?? [];
  const misses = selectorMisses(all, failed, changed, baseList);
  const row: MissRow = { at: new Date().toISOString(), sha, before, failed: failed.length, misses };
  const log = join(ROOT, "reports", "selector-misses.jsonl");
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(row)}\n`);
  const rows: MissRow[] = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const totalFailed = rows.reduce((n, r) => n + r.failed, 0);
  const totalMisses = rows.reduce((n, r) => n + r.misses.length, 0);
  console.log(`selector-misses: ${misses.length} of ${failed.length} failures this push`);
  if (misses.length) {
    console.log("\n| Mutation | Inputs line |\n| --- | --- |");
    for (const name of misses) {
      const m = all.find((e) => e.name === name)!;
      console.log(`| ${name} | \`"inputs": ${JSON.stringify(suggestedInputs(m.test, changed, ROOT))}\` |`);
    }
  }
  console.log(`\nMiss rate across ${rows.length} pushes: ${totalFailed ? totalMisses / totalFailed : 0}`);
  if (args.includes("--open-issues")) {
    for (const name of misses) {
      const m = all.find((e) => e.name === name)!;
      const title = missTitle(name);
      const list = Bun.spawnSync([
        "gh",
        "issue",
        "list",
        "--state",
        "open",
        "--search",
        `${title} in:title`,
        "--json",
        "title",
      ]);
      const open: { title: string }[] = list.exitCode === 0 ? JSON.parse(list.stdout.toString() || "[]") : [];
      if (open.some((i) => i.title === title)) continue;
      const body = missBody(m, sha, changed, suggestedInputs(m.test, changed, ROOT));
      Bun.spawnSync(["gh", "issue", "create", "--title", title, "--body", body]);
    }
  }
}
