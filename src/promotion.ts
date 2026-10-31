// A test file a run added is promoted only when it passes on head three times, fails on base, and kills a
// changed-line mutant (or the diff has no line to mutate); otherwise the record says delete.
// This module records, it never deletes: promotion.json is read at merge.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./artifacts";
import { runChangedLineMutants } from "./changed-mutants";
import { type FactoryConfig, testGate } from "./config";
import { type ProofGit, type ProofResult, runProof, ShellProofGit } from "./proof";
import { type LayerId, layerFor } from "./test-layers";

export const PROMOTION_FILE = "promotion.json";
export const MAX_PROMOTION_FILES = 3;
export const HEAD_RUNS = 3;
export const PROMOTION_MUTANTS = 5;

export interface Evidence {
  file: string;
  headPasses: number;
  failsOnBase: boolean;
  mutants: number;
  survived: number;
  seconds: number;
  layer: LayerId;
}

export type Decision = "promote" | "delete";

export interface PromotionDeps {
  git: ProofGit;
  mutants: typeof runChangedLineMutants;
  diff(worktree: string, base: string): Promise<string>;
}

const SESSION_TEST = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|_spec\.rb$/;

export function newTestFiles(changes: readonly { status: string; path: string }[]): string[] {
  return changes
    .filter((c) => c.status === "A" && SESSION_TEST.test(c.path))
    .map((c) => c.path)
    .slice(0, MAX_PROMOTION_FILES);
}

export function decide(e: Evidence): Decision {
  const killsOrNothingToKill = e.mutants === 0 || e.survived < e.mutants;
  return e.headPasses === HEAD_RUNS && e.failsOnBase && killsOrNothingToKill ? "promote" : "delete";
}

export async function promote(
  deps: PromotionDeps,
  worktree: string,
  base: string,
  fileCmd: string,
): Promise<{ file: string; decision: Decision; evidence: Evidence }[]> {
  const files = newTestFiles(await deps.git.changes(worktree, base));
  const out: { file: string; decision: Decision; evidence: Evidence }[] = [];
  for (const file of files) {
    const cmd = `${fileCmd} '${file.replaceAll("'", "'\\''")}'`;
    let headPasses = 0;
    let seconds = 0;
    for (let i = 0; i < HEAD_RUNS; i += 1) {
      const started = Date.now();
      const r = await deps.git.test(worktree, cmd);
      if (i === 0) seconds = (Date.now() - started) / 1000;
      if (r.code === 0) headPasses += 1;
    }
    const failsOnBase = (await runProof(deps.git, worktree, base, "test", cmd)).status === "bites";
    const m = await deps.mutants(worktree, await deps.diff(worktree, base), cmd, PROMOTION_MUTANTS);
    const evidence: Evidence = {
      file,
      headPasses,
      failsOnBase,
      mutants: m.mutants,
      survived: m.survived.length,
      seconds,
      layer: layerFor(seconds),
    };
    out.push({ file, decision: decide(evidence), evidence });
  }
  return out;
}

async function gitDiff(worktree: string, base: string): Promise<string> {
  const run = async (args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: worktree, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.trim()}`);
    return stdout;
  };
  const mergeBase = (await run(["merge-base", "HEAD", `origin/${base}`])).trim();
  return run(["diff", "-U0", mergeBase, "HEAD"]);
}

export async function recordPromotion(
  worktree: string,
  config: FactoryConfig,
  issue: number,
  proof: ProofResult,
  deps: PromotionDeps = { git: new ShellProofGit(), mutants: runChangedLineMutants, diff: gitDiff },
): Promise<void> {
  const fileCmd = testGate(config.gates)?.fileCmd;
  if (proof.status !== "bites" || !fileCmd) return;
  try {
    const decisions = await promote(deps, worktree, config.base, fileCmd);
    const dir = join(worktree, runDir(issue));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PROMOTION_FILE), `${JSON.stringify({ decisions }, null, 2)}\n`);
  } catch (err) {
    console.error(`promotion for #${issue} was not recorded:`, err);
  }
}
