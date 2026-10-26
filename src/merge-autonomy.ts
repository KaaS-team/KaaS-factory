// The merge step under an autonomy tier: the mode (web over config, tightened by the change
// failure rate), the PR facts at merge time, then one serial merge, a signed record of the
// decision, and the post-merge watch that opens a revert PR when the live smoke fails.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStageArtifacts, runDir } from "./artifacts";
import { type Autonomy, webMode } from "./autonomy";
import type { FactoryConfig, MergeConfig } from "./config";
import { attemptMerge, type ChangedFile, type MergeDecision, renderAuditComment } from "./merge-policy";
import { DirLease, type Lease, serialMerge } from "./merge-queue";
import { changeFailureRate, revertBranch, tightenThresholds, watchAfterMerge } from "./post-merge";
import { type PrFacts, mergeRecord, withMerge } from "./pr-facts";
import { readVerifyFacts } from "./pr-facts-collect";
import type { ScmPort } from "./ports/scm";
import type { FactoryState } from "./state";
import { buildStatement, receiptKey, renderReceipt, signStatement } from "./receipt";
import { isChecked } from "./recheck";
import { BLOCKING_CONFIDENCE, type Risk } from "./artifacts";
import { riskObject } from "./risk";
import { uiFacts, smoke } from "./visual";

const STATE = join(tmpdir(), "factory-merge");

// The merge history lives in the state DB beside the runs, so a reboot or another process on the
// same DB keeps the change failure rate, and the limits it tightened stay tight.
type History = Pick<FactoryState, "getSetting" | "setSetting">;
const historyKey = (repo: string) => `merge-history:${repo}`;

export function mergeHistory(state: History, repo: string): { reverted: boolean }[] {
  return JSON.parse(state.getSetting(historyKey(repo)) || "[]") as { reverted: boolean }[];
}

export function rememberMerge(state: History, repo: string, reverted: boolean): void {
  state.setSetting(historyKey(repo), JSON.stringify([...mergeHistory(state, repo), { reverted }].slice(-50)));
}

export interface MergeContext {
  readonly mode: Autonomy;
  readonly merge: MergeConfig;
  readonly facts?: PrFacts;
}

type Github = Pick<ScmPort, "listIssuesByLabel" | "currentLogin" | "roleOf">;

// Undefined when neither the web nor config set a tier: the merge then runs on merge.policy alone.
export async function mergeContext(
  deps: { github: Github; state: History },
  config: FactoryConfig,
  worktree: string,
  issue: number,
  changed: readonly ChangedFile[],
  pr: number,
): Promise<MergeContext | undefined> {
  const set = (await webMode(deps.github, config.repo).catch(() => undefined)) ?? config.merge.autonomy;
  if (!set) return undefined;
  const t = tightenThresholds(config.merge, set, changeFailureRate(mergeHistory(deps.state, config.repo)));
  const verify = await readVerifyFacts(worktree, issue);
  if (!verify) return { mode: t.mode, merge: { ...config.merge, ...t.limits } };
  const paths = changed.map((f) => f.path);
  const triage = (await readStageArtifacts(worktree, issue, "triage")).json as { risk?: unknown } | undefined;
  const plan = (await readStageArtifacts(worktree, issue, "plan")).json as { risk?: unknown } | undefined;
  const findings = ((await readStageArtifacts(worktree, issue, "verify")).json as { findings?: unknown[] } | undefined)
    ?.findings;
  const blockers = (findings ?? []).filter(
    (f) => isChecked(f as never) && (f as { confidence: number }).confidence >= BLOCKING_CONFIDENCE,
  ).length;
  const facts: PrFacts = {
    ...verify,
    review: verify.review && {
      ...verify.review,
      reviewers: verify.review.reviewers.map((r, i) => (i ? r : { ...r, blockers })),
    },
    risk: riskObject(
      triage,
      { risk: plan?.risk, files: paths },
      { protectedPaths: config.protectedPaths, packages: config.packages },
    ),
    ui: await uiFacts(paths, {
      previewTemplate: config.merge.previewUrl,
      pr,
      baseline: join(worktree, ".factory/visual/baseline"),
      current: join(worktree, runDir(issue), "visual"),
    }),
    postMergeWatch: Boolean(config.merge.smokeUrl),
  };
  return { mode: t.mode, merge: { ...config.merge, ...t.limits }, facts };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]}: ${(await new Response(p.stderr).text()).trim()}`);
  return out.trim();
}

// Rebases the PR branch on the latest base and pushes it when that moved the head.
export async function rebaseOnBase(worktree: string, base: string, branch: string): Promise<string> {
  await git(worktree, "fetch", "--quiet", "origin", base);
  const before = await git(worktree, "rev-parse", "HEAD");
  await git(worktree, "rebase", `origin/${base}`).catch(async (err) => {
    await git(worktree, "rebase", "--abort").catch(() => undefined);
    throw err;
  });
  const after = await git(worktree, "rev-parse", "HEAD");
  if (after !== before) await git(worktree, "push", "--force-with-lease", "origin", `HEAD:${branch}`);
  return after;
}

export interface AutonomousMergeDeps {
  readonly github: Pick<ScmPort, "mergePr" | "createPr">;
  readonly state: History;
  readonly lease?: Lease;
  readonly rebase?: () => Promise<string>;
  readonly smoke?: (url: string) => Promise<boolean>;
}

// The decision, its reasons and the facts it read, signed like the run receipt; undefined with no
// facts or no receipt key. The caller posts it once per head, beside the audit comment.
export function signedMergeRecord(
  config: FactoryConfig,
  issue: number,
  ctx: MergeContext,
  decision: MergeDecision,
  key = receiptKey(),
): string | undefined {
  if (!ctx.facts || !key) return undefined;
  const statement = buildStatement({
    repo: config.repo,
    issue,
    baseRef: config.base,
    baseSha: "",
    headSha: decision.headSha,
    at: new Date().toISOString(),
    holdoutRequired: false,
    runs: [],
    files: {},
    operatorDetail: false,
  });
  return renderReceipt(signStatement(withMerge(statement, mergeRecord(decision, ctx.facts, ctx.mode)), key));
}

async function autonomousMerge(
  deps: AutonomousMergeDeps,
  config: FactoryConfig,
  run: { worktree: string; pr: number; branch: string },
  decision: MergeDecision,
): Promise<boolean> {
  if (decision.outcome !== "merge") return false;
  const outcome = await serialMerge(deps.lease ?? new DirLease(STATE), config.repo, decision.headSha, {
    rebase: deps.rebase ?? (() => rebaseOnBase(run.worktree, config.base, run.branch)),
    gated: async (head) => head === decision.headSha,
    merge: async (head) => {
      await deps.github.mergePr(config.repo, run.pr, head);
      const url = config.merge.smokeUrl;
      if (!url) return;
      const watched = await watchAfterMerge(head, {
        smoke: () => (deps.smoke ?? smoke)(url),
        openRevert: async (sha, why) => {
          await git(run.worktree, "fetch", "--quiet", "origin", config.base);
          const tip = await git(run.worktree, "rev-parse", `origin/${config.base}`);
          await git(run.worktree, "checkout", "--quiet", "--detach", tip);
          const branch = await revertBranch(run.worktree, tip);
          await git(run.worktree, "push", "origin", `HEAD:${branch}`);
          return deps.github.createPr({
            repo: config.repo,
            base: config.base,
            head: branch,
            title: `Revert #${run.pr}`,
            body: `${why} (${sha}).`,
          });
        },
      });
      rememberMerge(deps.state, config.repo, !watched.ok);
    },
  });
  return outcome === "merged";
}

// decideMerge's tier inputs: the tightened limits and the PR facts under a tier, the plan's own
// rating otherwise. An unrated plan reads as high.
export function tierInput(auto: MergeContext | undefined, config: FactoryConfig, planRisk: Risk | undefined) {
  const risk: Risk = auto?.facts?.risk.level ?? planRisk ?? "high";
  return { risk, merge: auto?.merge ?? config.merge, autonomy: auto?.mode, facts: auto?.facts };
}

// `post` is set once per head: the audit comment, then the signed record beside it. Under a tier
// the merge is serial and watched; without one it is the plain policy merge.
export async function settleMerge(
  deps: AutonomousMergeDeps,
  config: FactoryConfig,
  auto: MergeContext | undefined,
  decision: MergeDecision,
  run: { worktree: string; pr: number; branch: string; issue: number; post?: (body: string) => Promise<unknown> },
): Promise<boolean> {
  if (run.post) {
    await run.post(renderAuditComment(decision));
    const signed = auto && signedMergeRecord(config, run.issue, auto, decision);
    if (signed) await run.post(signed);
  }
  if (!auto) return attemptMerge(deps.github, config.repo, run.pr, decision);
  return autonomousMerge(deps, config, run, decision);
}
