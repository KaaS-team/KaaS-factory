// The built-in step types a workflow's `uses:` names. Each handler is one
// stage of what used to be watch.ts's driveFromStage, unchanged in what it
// checks and posts. It returns "next" (the engine follows the step's edges
// and moves the label), "reject" (the engine follows `reject:`), or "stop"
// once it has parked or finished the issue itself, from `step.label`.

import { readFileSync } from "node:fs";
import { holdoutEnabled, type FactoryConfig } from "../config";
import { runHoldout } from "../holdout";
import {
  acceptanceProven,
  hiddenPaths,
  renderAcceptanceTable,
  renderPlanAcceptance,
  runAcceptance,
  type AcceptanceVerdict,
} from "../acceptance";
import {
  stepStop,
  validateVerdict,
  readGateEvidence,
  writeGateEvidence,
  readStageArtifacts,
  runDir,
  type BuildArtifact,
  type PlanArtifact,
  type TriageArtifact,
  type VerdictArtifact,
} from "../artifacts";
import { isChecked } from "../recheck";
import { hasNoGates, NO_GATES_COMMENT, runGates } from "../gates";
import { runProof, type ProofResult } from "../proof";
import { touchesProtectedPath } from "../boundary";
import {
  clearRunFiles,
  missingReceipt,
  readSeal,
  renderReceipt,
  sealKey,
  sealRunFiles,
  writeRunReceipt,
} from "../receipt";
import { ShellSetupRunner } from "../setup";
import type { GhIssue } from "../github";
import { LABEL, typesFor } from "../labels";
import { stepOpts, type Step, type StepKind, type Workflow } from "../core/workflow";
import { emitEvent } from "./bus";
import { prBody, renderWhatChanged } from "./pr-body";
import { failStage, failureLine, stageCause } from "./failure";
import { mcpStep } from "./mcp-step";
import { checkedPlan } from "./plan-critic";
import { proofInputs, recordVerifyFacts, secondReview } from "./verify-facts";
import {
  failureTail,
  finish,
  moveLabel,
  postComment,
  recheckFindings,
  runRetro,
  runStage,
  stageJson,
  stopStep,
  upsertStatusComment,
  type Outcome,
  type RunCtx,
  type WatchDeps,
} from "./common";

// A check step names a runtime this machine lacks. Boot refuses that, so this
// is a workflow edited while the watcher runs.
export class RuntimeMissing extends Error {}

export interface StepCtx {
  readonly deps: WatchDeps;
  readonly config: FactoryConfig;
  readonly issue: GhIssue;
  readonly worktree: string;
  readonly ctx: RunCtx;
  readonly step: Step;
  readonly workflow: Workflow;
}

// `facts` is the step's JSON, which later edges' `if:` read by the step's id.
export type StepResult =
  | { readonly kind: "next"; readonly facts?: unknown }
  | { readonly kind: "reject" }
  | { readonly kind: "stop"; readonly outcome: Outcome };

export interface StepType extends StepKind {
  run(sc: StepCtx): Promise<StepResult>;
}

const stop = (outcome: Outcome): StepResult => ({ kind: "stop", outcome });
// A needs-info answer from a step: ask, or hand over once the question rounds are used up.
async function askOrHandOver(sc: StepCtx, question: string | undefined): Promise<StepResult> {
  const { deps, config, issue, ctx, step, workflow } = sc;
  if (ctx.questionRound >= workflow.limits.questions) {
    await moveLabel(deps, config, issue.number, step.label, LABEL.needsHuman);
    finish(deps, config, issue.number, "needs-human", `unresolved after ${ctx.questionRound} rounds of questions`);
    return stop("needs-human");
  }
  ctx.questionRound += 1;
  if (question)
    await postComment(deps, config, issue.number, question, {
      stage: "question",
      json: { round: ctx.questionRound, stage: step.id },
    });
  await moveLabel(deps, config, issue.number, step.label, LABEL.needsInfo);
  finish(deps, config, issue.number, "needs-info");
  return stop("needs-info");
}

const triage: StepType = {
  agent: true,
  async run(sc) {
    const { deps, config, issue, worktree, step } = sc;
    const issueNumber = issue.number;
    // Someone else's open PR already closes this issue: don't spend tokens on a second fix.
    const own = deps.git.branchName(issueNumber);
    const taken = await deps.github.prForIssue(config.repo, issueNumber, { excludeHead: own });
    if (taken) {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
      finish(deps, config, issueNumber, "needs-human", `open PR #${taken.number} already closes this issue`);
      return stop("needs-human");
    }
    const result = await runStage(deps, config, issue, "triage", worktree, stepOpts(step));
    const art = await readStageArtifacts(worktree, issueNumber, "triage");
    const { json, problem } = stageJson<TriageArtifact>("triage", art.json, typesFor(config.routes));
    if (result.exitCode !== 0 || !json) {
      const fallback = "triage produced no valid triage.json";
      const cause = stageCause(config, issueNumber, "triage", result, { problem, fallback });
      return stop(await failStage(deps, config, issue, step.label, "triage", cause));
    }
    const triageStop = stepStop(json);
    if (triageStop) return stop(await stopStep(deps, config, issueNumber, step.label, triageStop));
    if (art.comment) await postComment(deps, config, issueNumber, art.comment, { stage: "triage", json });
    if (json.disposition === "refused" || json.disposition === "duplicate") {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
      finish(deps, config, issueNumber, "needs-human", json.disposition);
      return stop("needs-human");
    }
    if (json.disposition === "needs-info") return askOrHandOver(sc, art.question);
    return { kind: "next", facts: json };
  },
};

const plan: StepType = {
  agent: true,
  async run(sc) {
    const { deps, config, issue, worktree, step } = sc;
    const issueNumber = issue.number;
    const art = await checkedPlan(deps, config, issue, worktree, stepOpts(step));
    const { result, parsed } = art;
    const { json, problem } = parsed;
    // A plan stage that crashes (or writes nothing) used to fall through
    // to "not eligible" and park as awaiting-approval with no plan comment
    // to approve against — stuck forever (audit finding #10).
    if (result.exitCode !== 0 || !json) {
      const fallback = "plan produced no valid plan.json";
      const cause = stageCause(config, issueNumber, "plan", result, { problem, fallback });
      return stop(await failStage(deps, config, issue, step.label, "plan", cause));
    }
    const planStop = stepStop(json);
    if (planStop) return stop(await stopStep(deps, config, issueNumber, step.label, planStop));
    if (json.status === "needs-info") return askOrHandOver(sc, art.question);
    if (art.comment) await postComment(deps, config, issueNumber, art.comment, { stage: "plan", json });
    return { kind: "next", facts: json };
  },
};

// A rebuild is told why it came back, any agent; it forks the build session only if one was kept.
function rebuildFrom(sc: StepCtx): { resume?: { sessionId?: string; failure: string } } {
  const failure = sc.ctx.failure;
  delete sc.ctx.failure;
  const id =
    failure === undefined ? "" : sc.deps.state.lastSession(sc.config.repo, sc.issue.number, "build")?.session_id;
  return failure !== undefined ? { resume: { ...(id ? { sessionId: id } : {}), failure } } : {};
}

const build: StepType = {
  agent: true,
  async run(sc) {
    const { deps, config, issue, worktree, step } = sc;
    const issueNumber = issue.number;
    if (hasNoGates(worktree)) {
      await postComment(deps, config, issueNumber, NO_GATES_COMMENT);
      return stop(
        await stopStep(deps, config, issueNumber, step.label, {
          status: "needs-human",
          reason: "no gates in .factory/config.json",
        }),
      );
    }
    const result = await runStage(deps, config, issue, "build", worktree, {
      ...rebuildFrom(sc),
      ...(sc.ctx.rejectRound ? { rejects: sc.ctx.rejectRound } : {}),
      ...stepOpts(step),
    });
    const art = await readStageArtifacts(worktree, issueNumber, "build");
    const built = stageJson<BuildArtifact>("build", art.json);
    const problem = built.problem;
    // The runner owns the attempt count: the agent's copy of the file is cleared every round.
    const json = built.json && {
      ...built.json,
      rounds: deps.state.listStageRuns(config.repo, { issue: issueNumber }).filter((r) => r.stage === "build").length,
    };
    const buildStop = stepStop(json);
    if (buildStop) return stop(await stopStep(deps, config, issueNumber, step.label, buildStop));

    // The agent's own "needs-info" is a legitimate escape hatch (not a
    // crash), matched to the runner's exact spelling (audit finding #5:
    // the skill used to say `needs_info`).
    if (json?.status === "needs-info") {
      if (sc.ctx.questionRound < sc.workflow.limits.questions && art.comment)
        await upsertStatusComment(deps, config, issue, art.comment, json);
      return askOrHandOver(sc, art.question);
    }

    // The runner grades the build, not the agent (audit finding #11): run
    // the target's own gates.sh here and trust only its FACTORY_GATES line.
    const gate = await runGates(deps.gateRunner, worktree);
    if (art.comment) await upsertStatusComment(deps, config, issue, art.comment, { build: json ?? null, gate });

    if (result.exitCode !== 0 || !json || gate.status !== "GREEN") {
      deps.state.updateRun(config.repo, issueNumber, { gate_line: gate.raw });
      const cause = stageCause(config, issueNumber, "build", result, { problem, gate });
      return stop(await failStage(deps, config, issue, step.label, "build", cause));
    }

    // The runner commits — the build skill's own instructions say so, but
    // nothing enforced it before (audit finding #4). `.factory/runs/` is
    // excluded; it's the stage handoff, never meant to land in the repo.
    await deps.git.commitAll(worktree, `factory: build #${issueNumber}`);

    // Defense in depth behind the guard hook: a Bash-made edit to a
    // protected path never reaches Edit/Write, so the hook never sees it
    // (audit finding #12). Diff the branch itself before pushing anything.
    const changed = await deps.git.changedFiles(worktree, config.base);
    // `.factory/**` is already unconditionally protected below (ALWAYS_PROTECTED_PATHS),
    // covering the default holdout location; this adds any holdout path a
    // repo configured outside it.
    const protectedPaths = [
      ...config.protectedPaths,
      ...(await hiddenPaths(deps.setupRunner ?? new ShellSetupRunner(), config, worktree)),
    ];
    const hits = touchesProtectedPath(changed, protectedPaths);
    if (hits.length) {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
      finish(deps, config, issueNumber, "needs-human", `touched protected path(s): ${hits.join(", ")}`);
      return stop("needs-human");
    }

    deps.state.updateRun(config.repo, issueNumber, { gate_line: gate.raw });
    await writeGateEvidence(worktree, issueNumber, {
      line: gate.raw,
      status: gate.status,
      tree: await deps.git.treeHash(worktree),
    });
    await deps.git.push(worktree, issueNumber);
    return { kind: "next", facts: json };
  },
};

const verify: StepType = {
  agent: true,
  rejects: true,
  async run(sc) {
    const { deps, config, issue, worktree, ctx, step, workflow } = sc;
    const issueNumber = issue.number;
    const maxRejects = workflow.limits.rejects;
    // A verdict is only as good as its evidence: gate.json must describe
    // the tree being verified, so a resumed or amended run re-measures it.
    const tree = await deps.git.treeHash(worktree);
    const seen = await readGateEvidence(worktree, issueNumber);
    if (seen?.tree !== tree) {
      const fresh = await runGates(deps.gateRunner, worktree);
      deps.state.updateRun(config.repo, issueNumber, { gate_line: fresh.raw });
      await writeGateEvidence(worktree, issueNumber, { line: fresh.raw, status: fresh.status, tree });
      // Red evidence is a build problem, not something for the verifier to judge.
      if (fresh.status !== "GREEN") {
        ctx.rejectRound += 1;
        ctx.failure = failureTail(fresh.raw);
        if (ctx.rejectRound > maxRejects) {
          await moveLabel(deps, config, issueNumber, step.label, LABEL.failed);
          finish(
            deps,
            config,
            issueNumber,
            "failed",
            `gates ${fresh.status.toLowerCase()} before verify, ${ctx.rejectRound} times`,
          );
          return stop("failed");
        }
        return { kind: "reject" };
      }
    }
    // Also a build problem, not something for the verifier to judge: a
    // holdout test the build never saw is the one check its own gates.sh
    // cannot have been tuned to pass. Unlike the gates recheck above, this
    // runs on every entry to verify, not only a stale one — a fresh build
    // flowing straight into verify in the same tick is the common case,
    // and gate.json (written by the build, which never saw these paths)
    // cannot possibly already cover them.
    clearRunFiles(worktree, runDir(issueNumber));
    if (holdoutEnabled(config.holdout)) {
      const holdout = await runHoldout(deps.holdoutRunner, worktree, config.base, config.holdout);
      // A pass leaves no comment, so the run page reads the result from here.
      await Bun.write(
        `${worktree}/${runDir(issueNumber)}/holdout.json`,
        `${JSON.stringify({ ok: holdout.ok, cmd: config.holdout.cmd, tail: holdout.detail }, null, 2)}\n`,
      );
      if (!holdout.ok) {
        ctx.rejectRound += 1;
        ctx.failure = failureTail(`Holdout tests failed:\n${holdout.detail}`);
        await postComment(deps, config, issueNumber, `Holdout tests failed:\n\n\`\`\`\n${holdout.detail}\n\`\`\``, {
          stage: "verify",
          json: { holdout: holdout.detail },
        });
        if (ctx.rejectRound > maxRejects) {
          await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
          await runRetro(deps, config, issue, "gave-up");
          finish(deps, config, issueNumber, "needs-human", `holdout tests failed ${ctx.rejectRound} times`);
          return stop("needs-human");
        }
        return { kind: "reject" };
      }
    }
    if (deps.proofGit) {
      const { planProof, testCmd } = await proofInputs(deps.proofGit, worktree, config, issueNumber);
      let proof: ProofResult;
      try {
        proof = await runProof(deps.proofGit, worktree, config.base, planProof, testCmd);
      } catch (err) {
        proof = {
          status: "skipped",
          reverted: [],
          tests: [],
          cmd: testCmd ?? "",
          tail: `the runner could not run the proof: ${(err as Error).message}`,
        };
      }
      await Bun.write(`${worktree}/${runDir(issueNumber)}/proof.json`, `${JSON.stringify(proof, null, 2)}\n`);
      await recordVerifyFacts(worktree, config, issueNumber, testCmd, proof);
    }
    const acceptance = await runAcceptance(deps.setupRunner ?? new ShellSetupRunner(), worktree, config.base);
    if (acceptance)
      await Bun.write(`${worktree}/${runDir(issueNumber)}/acceptance.json`, `${JSON.stringify(acceptance, null, 2)}\n`);
    // The pr agent runs in this worktree next, so the receipt signs what verify sealed here, not what it finds later.
    // A run file that is not a regular file leaves no seal, and the PR then says "No receipt".
    const seal = await sealRunFiles(deps.setupRunner ?? new ShellSetupRunner(), worktree, runDir(issueNumber)).catch(
      () => undefined,
    );
    deps.state.setSetting(sealKey(config.repo, issueNumber), seal ? JSON.stringify(seal) : "");
    // Like a failing holdout, an unproven criterion is the build's to fix, not the verifier's to judge.
    if (acceptance && !acceptanceProven(acceptance)) {
      const table = renderAcceptanceTable(acceptance);
      ctx.rejectRound += 1;
      ctx.failure = failureTail(table);
      await postComment(deps, config, issueNumber, table, { stage: "verify", json: { acceptance } });
      if (ctx.rejectRound > maxRejects) {
        await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
        await runRetro(deps, config, issue, "gave-up");
        finish(deps, config, issueNumber, "needs-human", `acceptance not proven ${ctx.rejectRound} times`);
        return stop("needs-human");
      }
      return { kind: "reject" };
    }
    const result = await runStage(deps, config, issue, "verify", worktree, stepOpts(step));
    const art = await readStageArtifacts(worktree, issueNumber, "verify");
    const checked = art.json === undefined ? undefined : validateVerdict(art.json);
    let json = checked?.ok ? { ...checked.verdict, rounds: ctx.rejectRound + 1 } : undefined;
    let recheckNote = "";
    if (json && deps.rechecker && json.findings.some(isChecked)) {
      const rechecked = await recheckFindings(deps, config, worktree, json);
      json = rechecked.verdict;
      recheckNote = rechecked.note;
    }
    if (json) deps.state.setVerifyVerdict(config.repo, issueNumber, json.result);
    if (checked && !checked.ok) {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
      finish(deps, config, issueNumber, "needs-human", checked.reason);
      return stop("needs-human");
    }
    const verifyStop = stepStop(json);
    if (verifyStop) return stop(await stopStep(deps, config, issueNumber, step.label, verifyStop));
    if (result.exitCode !== 0 || !json || json.result === "uncertain") {
      // The human needs the verdict to act on, and the post is the marker that retires the retry that led here.
      if (art.comment)
        await postComment(deps, config, issueNumber, `${art.comment}${recheckNote}`, { stage: "verify", json });
      await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
      const fallback = json ? "verify uncertain" : "verify produced no valid verdict.json";
      const cause = stageCause(config, issueNumber, "verify", result, { fallback });
      finish(
        deps,
        config,
        issueNumber,
        "needs-human",
        (await failureLine(deps, config, issueNumber, "verify", cause)).line,
      );
      return stop("needs-human");
    }
    if (art.comment)
      await postComment(deps, config, issueNumber, `${art.comment}${recheckNote}`, { stage: "verify", json });
    if (json.result === "reject") {
      ctx.rejectRound += 1;
      ctx.failure = failureTail(art.comment ?? JSON.stringify(json.findings, null, 2));
      if (ctx.rejectRound > maxRejects) {
        await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
        await runRetro(deps, config, issue, "gave-up");
        finish(deps, config, issueNumber, "needs-human", `rejected ${ctx.rejectRound} times`);
        return stop("needs-human");
      }
      return { kind: "reject" };
    }
    await secondReview(deps, config, issue, worktree, step.mcp);
    return { kind: "next", facts: json };
  },
};

function readRunJson<T>(worktree: string, issueNumber: number, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(`${worktree}/${runDir(issueNumber)}/${name}`, "utf8")) as T;
  } catch {
    return undefined; // the stage that writes it did not run
  }
}

const pr: StepType = {
  agent: true,
  terminal: true,
  async run(sc) {
    const { deps, config, issue, worktree, ctx } = sc;
    const issueNumber = issue.number;
    await runStage(deps, config, issue, "pr", worktree, stepOpts(sc.step));
    const art = await readStageArtifacts(worktree, issueNumber, "pr");
    // A revise from in-review re-enters here with the PR already open;
    // the push in build already updated its branch.
    const head = deps.git.branchName(issueNumber);
    const receipt = await writeRunReceipt(deps.setupRunner ?? new ShellSetupRunner(), {
      worktree,
      runDir: runDir(issueNumber),
      repo: config.repo,
      issue: issueNumber,
      base: config.base,
      runs: deps.state.listStageRuns(config.repo, { issue: issueNumber }),
      operatorDetail: config.prRunSummary,
      holdoutRequired: holdoutEnabled(config.holdout),
      seal: readSeal(deps.state.getSetting(sealKey(config.repo, issueNumber))),
    }).then(renderReceipt, (err: Error) => missingReceipt(err.message));
    const existing = await deps.github.findPrByHead(config.repo, head);
    const plan = readRunJson<PlanArtifact>(worktree, issueNumber, "plan.json");
    const proof = readRunJson<ProofResult>(worktree, issueNumber, "proof.json");
    const prUrl =
      existing?.url ??
      (await deps.github.createPr({
        repo: config.repo,
        base: config.base,
        head,
        title: `${issue.title} (#${issueNumber})`,
        body: prBody(deps, config, issue, art.comment ?? `Closes #${issueNumber}`, ctx, {
          whatChanged: renderWhatChanged(
            plan?.goal ?? issue.title,
            await deps.git.changedFiles(worktree, config.base),
            proof,
          ),
          acceptance: renderPlanAcceptance(
            plan,
            readRunJson<VerdictArtifact>(worktree, issueNumber, "verdict.json")?.criteria,
            readRunJson<AcceptanceVerdict>(worktree, issueNumber, "acceptance.json"),
          ),
          receipt,
          proof: proof?.status,
        }),
        draft: true,
      }));
    if (!existing)
      emitEvent(
        deps.bus,
        "factory.pr.opened",
        { repo: config.repo, issue: issueNumber, url: prUrl, head },
        `issue/${issueNumber}`,
      );
    // Opened as a draft while the factory works; ready is the hand-off to a human.
    await deps.github.markReady(config.repo, head, true);
    deps.state.updateRun(config.repo, issueNumber, { pr_url: prUrl });
    finish(deps, config, issueNumber, "shipped");
    return stop("shipped");
  },
};

// A shell command in the worktree, no agent and no tokens: exit 0 goes on, anything else parks
// the issue as failed with the output's tail, the same way a red build does.
const check: StepType = {
  command: true,
  async run(sc) {
    const { deps, config, issue, worktree, step } = sc;
    const name = step.runtime ?? config.runtime?.check;
    const runtime = name ? deps.runtimes?.[name] : (deps.setupRunner ?? new ShellSetupRunner());
    if (!runtime) throw new RuntimeMissing(`no runtime "${name}" on this machine`);
    const out = await runtime.run(step.run!, worktree);
    if (out.code === 0) return { kind: "next", facts: { ok: true } };
    const tail = `${out.stdout}\n${out.stderr}`.trim().slice(-4000);
    await postComment(
      deps,
      config,
      issue.number,
      `Step \`${step.id}\` failed: \`${step.run}\` exited ${out.code}.\n\n\`\`\`\n${tail}\n\`\`\``,
      { stage: step.id, json: { ok: false, code: out.code } },
    );
    await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
    finish(deps, config, issue.number, "failed", `${step.id}: \`${step.run}\` exited ${out.code}`);
    return stop("failed");
  },
};

export const STEP_TYPES: Readonly<Record<string, StepType>> = { triage, plan, build, verify, pr, check, mcp: mcpStep };
