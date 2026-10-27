// The P6 pieces of the plan and verify steps, kept out of steps.ts: the plan's risk floor, the
// monorepo proof command, and the PR facts a tiered merge reads.
import { lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCKING_CONFIDENCE,
  COMMENT_FILENAMES,
  JSON_FILENAMES,
  readStageArtifacts,
  runDir,
  type Risk,
} from "../artifacts";
import { resolveRoute } from "../agents/executor";
import { type FactoryConfig, testGate } from "../config";
import type { GhIssue } from "../github";
import { issueType } from "../labels";
import { collectVerifyFacts, readVerifyFacts, writeVerifyFacts } from "../pr-facts-collect";
import { isChecked } from "../recheck";
import { crossModel } from "../review-models";
import { labelsOf, runStage } from "./common";
import { isMutation, type PlanMutation, type ProofGit, type ProofResult, proofCommand, runMutations } from "../proof";
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
  const plan = (await readStageArtifacts(worktree, issue, "plan")).json as
    | { proof?: "test" | "check"; mutations?: unknown[] }
    | undefined;
  const changed = config.packages?.length ? await git.changes(worktree, config.base) : [];
  const paths = changed.map((c) => c.path);
  return {
    planProof: plan?.proof,
    testCmd: proofCommand(config.gates, config.packages ?? [], paths),
    mutations: (plan?.mutations ?? []).filter(isMutation),
  };
}

// The names of the plan's mutations whose test still passed, with the test's output tail.
// Each is applied to the worktree and put back before the next.
export async function survivingMutations(
  git: ProofGit,
  worktree: string,
  config: FactoryConfig,
  mutations: readonly PlanMutation[],
): Promise<{ names: string[]; body: string } | undefined> {
  if (!git.mutations || mutations.length === 0) return undefined;
  const gate = testGate(config.gates);
  // A test gate with fileCmd runs only the named test; without one, the whole gate runs.
  const cmdFor = (test: string) => {
    if (!gate?.fileCmd) return gate?.cmd ?? test;
    return `${gate.fileCmd} '${test.replaceAll("'", "'\\''")}'`;
  };
  const survivors = (await runMutations(git.mutations, worktree, mutations, cmdFor)).filter(
    (r) => r.status === "survives",
  );
  if (survivors.length === 0) return undefined;
  const body = `Plan mutations whose test still passed:\n\n${survivors
    .map((s) => `- \`${s.name}\`\n\n\`\`\`\n${s.tail}\n\`\`\``)
    .join("\n\n")}`;
  return { names: survivors.map((s) => s.name), body };
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

// High risk adds a second review session on a third model, neither the builder's nor the first
// reviewer's. Its verdict joins the PR facts the receipt signs, and anything but a pass blocks the
// merge. The first reviewer's files are put back, so the PR and the receipt still read its verdict.
export async function secondReview(
  deps: Parameters<typeof runStage>[0],
  config: FactoryConfig,
  issue: GhIssue,
  worktree: string,
  mcp?: readonly string[],
  run = runStage,
): Promise<void> {
  const facts = await readVerifyFacts(worktree, issue.number);
  const plan = (await readStageArtifacts(worktree, issue.number, "plan")).json as { risk?: unknown } | undefined;
  if (!facts?.review || plan?.risk !== "high") return;
  const type = issueType(config.routes, labelsOf(issue));
  const route = (s: "build" | "verify") => resolveRoute(config.agents, config.stages, config.routes, s, type);
  const [builder, verify] = [route("build"), route("verify")];
  const model = crossModel(verify, builder, 1).config.model;
  if (!model || model === builder.config.model || model === crossModel(verify, builder).config.model) return;
  const dir = join(worktree, runDir(issue.number));
  const names = [JSON_FILENAMES.verify, COMMENT_FILENAMES.verify, "question-comment.md"];
  // Only regular files are kept and put back fresh, so a link a session planted never redirects a write.
  const regular = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isFile() === true;
  const kept = names.map((n) => (regular(join(dir, n)) ? readFileSync(join(dir, n)) : undefined));
  let reviewer: { model: string; blockers: number; verdict: string };
  try {
    const result = await run(deps, config, issue, "verify", worktree, { mcp, reviewer: 1 });
    const v = (await readStageArtifacts(worktree, issue.number, "verify")).json as
      | { result?: string; findings?: unknown[] }
      | undefined;
    const blockers = (v?.findings ?? []).filter(
      (f) => isChecked(f as never) && (f as { confidence: number }).confidence >= BLOCKING_CONFIDENCE,
    ).length;
    reviewer = {
      model: result.model ?? model,
      blockers,
      verdict: result.exitCode === 0 ? (v?.result ?? "none") : "failed",
    };
  } finally {
    names.forEach((n, i) => {
      rmSync(join(dir, n), { force: true });
      const body = kept[i];
      if (body) writeFileSync(join(dir, n), body, { flag: "wx" });
    });
  }
  await writeVerifyFacts(worktree, issue.number, {
    ...facts,
    review: { ...facts.review, reviewers: [...facts.review.reviewers, reviewer] },
  });
}
