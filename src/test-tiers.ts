// Tests a plan adds are tagged "(scaffold)" or "(permanent)" on their "Tests to write first" line.
// After merge a scaffold test no mutation guards is listed for removal, and the permanent count is
// recorded for the run, in one file per issue, so suite growth is visible.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDir } from "./artifacts";

export type Tier = "scaffold" | "permanent";
export interface TestTier {
  readonly test: string;
  readonly tier?: Tier;
}

const TIER = /\((scaffold|permanent)\)\s*$/i;

export function testTiers(comment: string): TestTier[] {
  const at = comment.search(/^###\s+Tests to write first/im);
  if (at < 0) return [];
  const rest = comment.slice(at).split("\n").slice(1).join("\n");
  const end = rest.search(/^###?\s/m);
  const found: TestTier[] = [];
  for (const line of (end < 0 ? rest : rest.slice(0, end)).split("\n")) {
    const name = /^\s*-\s*`([^`]+)`/.exec(line)?.[1];
    if (!name) continue;
    const tier = TIER.exec(line)?.[1]?.toLowerCase() as Tier | undefined;
    found.push(tier ? { test: name, tier } : { test: name });
  }
  return found;
}

// A scaffold test that a mutation names is the proof a check bites, so the final change still needs it.
export function pruneList(tiers: readonly TestTier[], guarded: ReadonlySet<string>): string[] {
  return tiers.filter((t) => t.tier === "scaffold" && !guarded.has(t.test.replace(/^\.\//, ""))).map((t) => t.test);
}

export function tierRecord(tiers: readonly TestTier[], guarded: ReadonlySet<string>) {
  return {
    permanent: tiers.filter((t) => t.tier !== "scaffold").length,
    scaffold: tiers.filter((t) => t.tier === "scaffold").length,
    prune: pruneList(tiers, guarded),
  };
}

// The test each mutation names, from the old list and the per-entry files. The runner image does not
// carry scripts/, so this reads them itself instead of importing the loader.
function guardedTests(root: string): Set<string> {
  const files = [join(root, "tests", "mutations.json")];
  const dir = join(root, "tests", "mutations");
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith(".json")) files.push(join(dir, f));
  const tests = new Set<string>();
  for (const file of files.filter(existsSync)) {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      const test = (m as { test?: unknown }).test;
      if (typeof test === "string") tests.add(test.replace(/^\.\//, ""));
    }
  }
  return tests;
}

// Run after a merge: writes the record to outFile and returns it.
export function recordTestTiers(root: string, outFile: string, comment: string) {
  const guarded = guardedTests(root);
  const record = tierRecord(testTiers(comment), guarded);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

// Written beside the workspaces, not in the worktree, which is dropped right after a merge.
// Never fails the retro: no plan comment, or an unreadable mutation list, only means nothing is recorded.
export function recordMergedTestTiers(workspacesDir: string, worktree: string, issue: number): void {
  const planFile = join(worktree, runDir(issue), "plan-comment.md");
  if (!existsSync(planFile)) return;
  try {
    recordTestTiers(worktree, join(workspacesDir, "test-tiers", `issue-${issue}.json`), readFileSync(planFile, "utf8"));
  } catch (err) {
    console.error(`test tiers not recorded for #${issue}:`, err);
  }
}
