// The P6 pieces of the plan and verify steps, kept out of steps.ts: the plan's risk floor, the
// monorepo proof command, and the PR facts a tiered merge reads.
import { readStageArtifacts, type Risk } from "../artifacts";
import type { FactoryConfig } from "../config";
import { collectVerifyFacts, writeVerifyFacts } from "../pr-facts-collect";
import { type ProofGit, type ProofResult, proofCommand } from "../proof";
import { floorPlanRisk } from "../risk";

export function flooredPlan<P extends { risk: Risk; files: readonly string[] }, R extends { json?: P }>(
  parsed: R,
  config: FactoryConfig,
): R {
  return parsed.json ? { ...parsed, json: floorPlanRisk(parsed.json, config) } : parsed;
}

// The plan's proof kind, and the top-level test gate plus each touched package's, so a monorepo
// proof reaches the package the diff changed.
export async function proofInputs(git: ProofGit, worktree: string, config: FactoryConfig, issue: number) {
  const plan = (await readStageArtifacts(worktree, issue, "plan")).json as { proof?: "test" | "check" } | undefined;
  const changed = config.packages?.length ? await git.changes(worktree, config.base) : [];
  const paths = changed.map((c) => c.path);
  return { planProof: plan?.proof, testCmd: proofCommand(config.gates, config.packages ?? [], paths) };
}

// Only a repo that can merge on its own pays for mutants and a clean room. A failed collection
// writes nothing, so the merge reads the signals as missing and refuses.
export async function recordVerifyFacts(
  worktree: string,
  config: FactoryConfig,
  issue: number,
  testCmd: string | undefined,
  proof: ProofResult,
): Promise<void> {
  if (config.merge.policy === "off" && !config.merge.autonomy) return;
  try {
    await writeVerifyFacts(worktree, issue, await collectVerifyFacts(worktree, config, issue, testCmd, proof));
  } catch (err) {
    console.error(`verify facts for #${issue} were not collected:`, err);
  }
}
