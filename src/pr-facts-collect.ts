// Gathers the verify-time PR facts into the run dir's pr-facts.json: the tamper check, changed-line
// mutants, the clean-room run, the supply-chain gate and the review models. The merge step adds the
// facts only it can know (risk on the PR head, UI preview and smoke, the post-merge watch).

import { BLOCKING_CONFIDENCE, readStageArtifacts, runDir } from "./artifacts";
import { resolveRoute } from "./agents/executor";
import { runChangedLineMutants } from "./changed-mutants";
import { runCleanRoom } from "./clean-room";
import { holdoutEnabled, type FactoryConfig } from "./config";
import type { PrFacts } from "./pr-facts";
import type { ProofResult } from "./proof";
import { isChecked } from "./recheck";
import { reviewModel } from "./review-models";
import { tamperHits } from "./tamper";

export const PR_FACTS_FILE = "pr-facts.json";
export type VerifyFacts = Pick<PrFacts, "cleanRoom" | "changedLines" | "tamper" | "supplyChain" | "review">;

async function sh(cwd: string, cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

// Names a diff adds to any package.json's dependency blocks.
export function newDependencies(diff: string): string[] {
  const out: string[] = [];
  let inManifest = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) inManifest = line.endsWith("package.json");
    const m = inManifest && /^\+\s*"(@?[\w./-]+)"\s*:\s*"[~^]?\d/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

export async function collectVerifyFacts(
  worktree: string,
  config: FactoryConfig,
  issue: number,
  testCmd: string | undefined,
  proof: ProofResult | undefined,
  type?: string,
): Promise<VerifyFacts> {
  const base = (await sh(worktree, ["git", "merge-base", "HEAD", `origin/${config.base}`])).out.trim();
  const head = (await sh(worktree, ["git", "rev-parse", "HEAD"])).out.trim();
  const diff = (await sh(worktree, ["git", "diff", "-U0", base, "HEAD"])).out;
  const holdouts = holdoutEnabled(config.holdout) ? config.holdout.paths : [];
  const room = testCmd
    ? await runCleanRoom({ repoDir: worktree, sha: head, holdouts: { baseSha: base, paths: holdouts }, cmd: testCmd })
    : undefined;
  const supply = config.gates.find((g) => g.name === "supply-chain");
  const supplyRun = supply && (await sh(worktree, ["bash", "-c", supply.cmd]));
  const verify = (await readStageArtifacts(worktree, issue, "verify")).json as { findings?: unknown[] } | undefined;
  const blockers = (verify?.findings ?? []).filter(
    (f) => isChecked(f as never) && (f as { confidence: number }).confidence >= BLOCKING_CONFIDENCE,
  ).length;
  const builder = resolveRoute(config.agents, config.stages, config.routes, "build", type).config;
  const reviewer = resolveRoute(config.agents, config.stages, config.routes, "verify", type).config;
  const model = reviewModel(reviewer.model, builder.model, [reviewer.model, ...Object.values(reviewer.models ?? {})]);
  return {
    tamper: tamperHits(diff),
    changedLines: testCmd ? await runChangedLineMutants(worktree, diff, testCmd) : null,
    cleanRoom: room
      ? { ran: room.ran, failToPass: proof?.status === "bites", passToPass: room.ran && room.exitCode === 0 }
      : null,
    supplyChain: supplyRun
      ? { highFindings: supplyRun.code === 0 ? 0 : 1, alerts: 0, newDependencies: newDependencies(diff) }
      : null,
    review: builder.model && model ? { builderModel: builder.model, reviewers: [{ model, blockers }] } : null,
  };
}

export async function writeVerifyFacts(worktree: string, issue: number, facts: VerifyFacts): Promise<void> {
  await Bun.write(`${worktree}/${runDir(issue)}/${PR_FACTS_FILE}`, `${JSON.stringify(facts, null, 2)}\n`);
}

export async function readVerifyFacts(worktree: string, issue: number): Promise<VerifyFacts | undefined> {
  const f = Bun.file(`${worktree}/${runDir(issue)}/${PR_FACTS_FILE}`);
  return (await f.exists()) ? ((await f.json()) as VerifyFacts) : undefined;
}
