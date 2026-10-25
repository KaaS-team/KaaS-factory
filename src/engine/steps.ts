// The built-in step types a workflow's `uses:` names. Each handler is one
// stage of what used to be watch.ts's driveFromStage, unchanged in what it
// checks and posts. It returns "next" (the engine follows the step's edges
// and moves the label), "reject" (the engine follows `reject:`), or "stop"
// once it has parked or finished the issue itself, from `step.label`.

import { readFileSync } from "node:fs";
import { holdoutEnabled, testGate, type FactoryConfig } from "../config";
import { runHoldout } from "../holdout";
import {
  acceptanceProven,
  hiddenPaths,
  renderAcceptanceTable,
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
} from "../artifacts";
import { isChecked } from "../recheck";
import { hasNoGates, NO_GATES_COMMENT, runGates } from "../gates";
import { runProof, type ProofResult, type ProofStatus } from "../proof";
import { touchesProtectedPath } from "../boundary";
import { missingReceipt, renderReceipt, writeRunReceipt } from "../receipt";
import { ShellSetupRunner } from "../setup";
import type { GhIssue } from "../github";
import { LABEL, typesFor } from "../labels";
import type { Step, StepKind, Workflow } from "../core/workflow";
import { emitEvent } from "./bus";
import {
  failureTail,
  finish,
  moveLabel,
  postComment,
  prBody,
  recheckFindings,
  runRetro,
  runStage,
  stageFailure,
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
    const result = await runStage(deps, config, issue, "triage", worktree, { mcp: step.mcp });
    const art = await readStageArtifacts(worktree, issueNumber, "triage");
    const { json, problem } = stageJson<TriageArtifact>("triage", art.json, typesFor(config.routes));
    if (result.exitCode !== 0 || !json) {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.failed);
      finish(
        deps,
        config,
        issueNumber,
        "failed",
        problem ?? stageFailure(result, "triage produced no valid triage.json"),
      );
      return stop("failed");
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
    const result = await runStage(deps, config, issue, "plan", worktree, { mcp: step.mcp });
    const art = await readStageArtifacts(worktree, issueNumber, "plan");
    const { json, problem } = stageJson<PlanArtifact>("plan", art.json);
    // A plan stage that crashes (or writes nothing) used to fall through
    // to "not eligible" and park as awaiting-approval with no plan comment
    // to approve against — stuck forever (audit finding #10).
    if (result.exitCode !== 0 || !json) {
      await moveLabel(deps, config, issueNumber, step.label, LABEL.failed);
      finish(deps, config, issueNumber, "failed", problem ?? stageFailure(result, "plan produced no valid plan.json"));
      return stop("failed");
    }
    const planStop = stepStop(json);
    if (planStop) return stop(await stopStep(deps, config, issueNumber, step.label, planStop));
    if (json.status === "needs-info") return askOrHandOver(sc, art.question);
    if (art.comment) await postComment(deps, config, issueNumber, art.comment, { stage: "plan", json });
    return { kind: "next", facts: json };
  },
};

// A rebuild after a reject resumes the last build session, told why it came
// back; a first build, or one whose agent kept no session, starts fresh.
function rebuildFrom(sc: StepCtx): { resume?: { sessionId: string; failure: string } } {
  const failure = sc.ctx.failure;
  delete sc.ctx.failure;
  const last = failure === undefined ? undefined : sc.deps.state.lastSession(sc.config.repo, sc.issue.number, "build");
  return last && failure !== undefined ? { resume: { sessionId: last.session_id, failure } } : {};
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
    const result = await runStage(deps, config, issue, "build", worktree, { ...rebuildFrom(sc), mcp: step.mcp });
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
      await moveLabel(deps, config, issueNumber, step.label, LABEL.failed);
      deps.state.updateRun(config.repo, issueNumber, { gate_line: gate.raw });
      const reason =
        problem ??
        stageFailure(result) ??
        `gates ${gate.status.toLowerCase()}${gate.failedGates.length ? `: ${gate.failedGates.join(", ")}` : ""}`;
      finish(deps, config, issueNumber, "failed", reason);
      return stop("failed");
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
      const planJson = (await readStageArtifacts(worktree, issueNumber, "plan")).json as
        | { proof?: "test" | "check" }
        | undefined;
      const testCmd = testGate(config.gates)?.cmd;
      let proof: ProofResult;
      try {
        proof = await runProof(deps.proofGit, worktree, config.base, planJson?.proof, testCmd);
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
    }
    const acceptance = await runAcceptance(deps.setupRunner ?? new ShellSetupRunner(), worktree, config.base);
    if (acceptance)
      await Bun.write(`${worktree}/${runDir(issueNumber)}/acceptance.json`, `${JSON.stringify(acceptance, null, 2)}\n`);
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
    const result = await runStage(deps, config, issue, "verify", worktree, { mcp: step.mcp });
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
      finish(
        deps,
        config,
        issueNumber,
        "needs-human",
        stageFailure(result, json ? "verify uncertain" : "verify produced no valid verdict.json"),
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
    return { kind: "next", facts: json };
  },
};

function readAcceptance(worktree: string, issueNumber: number): AcceptanceVerdict | undefined {
  try {
    return JSON.parse(readFileSync(`${worktree}/${runDir(issueNumber)}/acceptance.json`, "utf8")) as AcceptanceVerdict;
  } catch {
    return undefined; // the repo has no check-acceptance.py
  }
}

function readProofStatus(worktree: string, issueNumber: number): ProofStatus | undefined {
  try {
    return (JSON.parse(readFileSync(`${worktree}/${runDir(issueNumber)}/proof.json`, "utf8")) as ProofResult).status;
  } catch {
    return undefined; // the proof did not run
  }
}

const pr: StepType = {
  agent: true,
  terminal: true,
  async run(sc) {
    const { deps, config, issue, worktree, ctx } = sc;
    const issueNumber = issue.number;
    await runStage(deps, config, issue, "pr", worktree, { mcp: sc.step.mcp });
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
    }).then(renderReceipt, (err: Error) => missingReceipt(err.message));
    const existing = await deps.github.findPrByHead(config.repo, head);
    const prUrl =
      existing?.url ??
      (await deps.github.createPr({
        repo: config.repo,
        base: config.base,
        head,
        title: `${issue.title} (#${issueNumber})`,
        body: prBody(
          deps,
          config,
          issue,
          art.comment ?? `Closes #${issueNumber}`,
          ctx,
          readProofStatus(worktree, issueNumber),
          readAcceptance(worktree, issueNumber),
          receipt,
        ),
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

export const STEP_TYPES: Readonly<Record<string, StepType>> = { triage, plan, build, verify, pr, check };
