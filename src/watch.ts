// The runner: polls GitHub, claims issues, drives each stage's executor in a
// worktree, and is the only thing that talks to GitHub (plan section 9). A
// stage skill never calls `gh` or pushes; it writes its comment bodies and
// verdicts to `.factory/runs/issue-<N>/*` (see artifacts.ts) and this file
// posts them, sets labels, runs gates, commits, pushes, and opens the PR.
//
// GitHub is the state (audit findings #18-#21): nothing here is required to
// survive in the local SQLite DB. `deriveIssueState` (derive.ts) recovers
// stage, round counts and the status-comment id from the issue's labels and
// comment thread alone, so a restarted watcher, a fresh CI job, or a runner
// on a different machine can all resume any issue.

import { mergeContext, settleMerge, tierInput } from "./merge-autonomy";
import { resolveBlockers } from "./blockers";
import { intakeGate } from "./dispatch";
import type { FactoryConfig } from "./config";
import { writeRevision } from "./revision";
import { runDir, readStageArtifacts, type PlanArtifact } from "./artifacts";
import { isHumanComment, isTrusted, latestTrustedCommentAfter, parseChatOps, unsigned } from "./chatops";
import { ciStatusNow, validatePr } from "./ci";
import { deriveIssueState, parkWindowStart } from "./derive";
import { decideMerge, mergePolicyMarker } from "./merge-policy";
import { admitReady } from "./org-caps";
import { capsFor, codeownerCheck } from "./profile-rules";
import { runPool } from "./pool";
import type { GhComment, GhIssue } from "./github";
import { issueType, LABEL, PARKED_LABELS } from "./labels";
import { canServe, effectiveSlots, machineBeat } from "./machine";
import { stepByLabel, type Workflow } from "./core/workflow";
import {
  ensureWorktreeReady,
  finish,
  labelsOf,
  leased,
  postComment,
  runQueuedRetros,
  runRetro,
  worktreeFor,
  type Outcome,
  type RunCtx,
  type WatchDeps,
  withDataMarker,
} from "./engine/common";
import { parkEdgeOf, runWorkflow } from "./engine/runner";
import { ALL_STEP_TYPES as STEP_TYPES } from "./engine/registry";
import { defaultWorkflow } from "./engine/workflows";

import { cronStore, fireCron, fireEvent } from "./engine/triggers";
import { recordedWorkflow, WORKFLOW_MARKER } from "./engine/late-route";
import { dueCronMinions, minionsFor, runMinion } from "./engine/minion";
import { isExternalEventType, type CloudEvent } from "./core/event";
import type { Minion } from "./core/minion";
import { emitEvent } from "./engine/bus";
import { shipRunState } from "./engine/blobs";
import { TRUSTED_ROLES } from "./ports/scm";
import { cachedRole, isWriter, writersOnly } from "./trust";
export type { Outcome, Stage, WatchDeps } from "./engine/common";

export interface PollResult {
  readonly paused: boolean;
  readonly reason?: string;
  readonly processed: number[];
}

// The workflow an issue runs: the one its pickup recorded (a route's, see
// chooseWorkflow), else the repo's. Read from the thread, so it holds across
// restarts and machines, and an issue never switches workflow mid-run.
function workflowOf(deps: WatchDeps, issue?: GhIssue): Workflow {
  const chosen = issue ? recordedWorkflow(issue) : undefined;
  return (chosen && deps.routeWorkflows?.[chosen]) || deps.workflow || defaultWorkflow();
}

// An issue a route's trigger filed runs that workflow, not the repo's, so pickup reads it back (recordedWorkflow).
async function recordTriggered(deps: WatchDeps, config: FactoryConfig, n: number, workflow: Workflow, via: string) {
  if (workflow.name === workflowOf(deps).name) return;
  const body = withDataMarker(`Running workflow \`${workflow.name}\` (\`${via}\`).`, WORKFLOW_MARKER, {
    name: workflow.name,
  });
  await deps.github.commentIssue(config.repo, n, body);
}

// The repo's workflow and every one a route names: what cron fires and recovery scans.
function allWorkflows(deps: WatchDeps): Workflow[] {
  return [workflowOf(deps), ...Object.values(deps.routeWorkflows ?? {})];
}

// At pickup: the workflow its type's route names (routes.<type>.workflow), recorded on the issue so
// every later step reads the same one. An issue whose type has none runs the repo's, and gets no comment.
async function chooseWorkflow(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): Promise<GhIssue> {
  const type = issueType(config.routes, labelsOf(issue));
  const name = type ? config.routes[type]?.workflow : undefined;
  if (!name || !deps.routeWorkflows?.[name] || name === workflowOf(deps).name || recordedWorkflow(issue)) return issue;
  const body = withDataMarker(`Running workflow \`${name}\` (\`routes.${type}.workflow\`).`, WORKFLOW_MARKER, { name });
  const id = await deps.github.commentIssue(config.repo, issue.number, body);
  return {
    ...issue,
    comments: [
      ...issue.comments,
      { id: id ?? 0, author: "factory", authorAssociation: "OWNER", body, createdAt: new Date().toISOString() },
    ],
  };
}

function labelOf(deps: WatchDeps, issue: GhIssue, stepId: string): string {
  return workflowOf(deps, issue).steps[stepId]!.label;
}

function runFromStage(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  stepId: string,
  worktree: string,
  ctx?: RunCtx,
): Promise<Outcome> {
  // With leases on, only the lease holder walks the steps: a second worker
  // (another machine, a CI job) gets "waiting", and a dead worker's issue is
  // reclaimed by whoever resumes it after the TTL.
  return leased(deps, issue.number, () =>
    runWorkflow(deps, config, workflowOf(deps, issue), issue, stepId, worktree, ctx),
  );
}

// Intake trust (P36): a label is a request to spend tokens and push a branch,
// so it counts only from someone who could push that branch themselves.
// Anyone else's factory:ready is taken off with a comment saying why.
const roleOf = (deps: WatchDeps, config: FactoryConfig, login: string) => cachedRole(deps.github, config.repo, login);
const commandIsTrusted = (deps: WatchDeps, config: FactoryConfig, c: GhComment) =>
  isWriter(deps.github, config.repo, c);
const keepTrusted = (deps: WatchDeps, config: FactoryConfig, comments: readonly GhComment[]) =>
  writersOnly(deps.github, config.repo, comments);
const trustedThread = async (deps: WatchDeps, config: FactoryConfig, issue: GhIssue): Promise<GhIssue> =>
  Object.assign({}, issue, { comments: await keepTrusted(deps, config, issue.comments) });

async function readyIsTrusted(issue: GhIssue, deps: WatchDeps, config: FactoryConfig): Promise<boolean> {
  const by = await deps.github.labeledBy(config.repo, issue.number, LABEL.ready);
  const role = by ? await roleOf(deps, config, by) : "none";
  if (TRUSTED_ROLES.includes(role)) return true;
  await deps.github.removeLabels(config.repo, issue.number, [LABEL.ready]);
  await postComment(
    deps,
    config,
    issue.number,
    `\`${LABEL.ready}\` was removed: ${by ? `@${by} has the ${role} role here` : "the issue history does not say who applied it"}, and the factory starts only for people with write access or higher. A maintainer can add the label again to start it.`,
  );
  return false;
}

export async function processReadyIssue(issue: GhIssue, deps: WatchDeps, config: FactoryConfig): Promise<Outcome> {
  if (!(await readyIsTrusted(issue, deps, config))) return "untrusted";
  const claimed = await deps.git.claim(deps.cloneDir, issue.number, config.base);
  if (!claimed) {
    // Another runner may have claimed it first, or `factory:ready` was
    // re-applied to an issue whose branch already exists from an earlier,
    // now-parked run. Either way, silently dropping it would strand the
    // issue — say so instead of losing the claim quietly.
    await postComment(
      deps,
      config,
      issue.number,
      "This issue's `factory/issue-" +
        issue.number +
        "` branch already exists, so the claim was not renewed — either another run is already in flight, or a previous run parked here. Use `/factory retry` on the parked labels, not a fresh `" +
        LABEL.ready +
        "`.",
    );
    await deps.github.removeLabels(config.repo, issue.number, [LABEL.ready]);
    return "lost-claim";
  }
  const worktree = worktreeFor(deps, issue.number);
  if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, LABEL.ready))) return "needs-human";
  issue = await chooseWorkflow(deps, config, issue);
  emitEvent(
    deps.bus,
    "factory.issue.ready",
    { repo: config.repo, issue: issue.number, title: issue.title, workflow: workflowOf(deps, issue).name },
    `issue/${issue.number}`,
  );
  const start = workflowOf(deps, issue).start;
  await deps.github.setStateLabel(config.repo, issue.number, [LABEL.ready], labelOf(deps, issue, start));
  return runFromStage(deps, config, issue, start, worktree);
}

// `/factory cancel` in any waiting state: drop the lifecycle labels, close the
// PR and the issue, and remove the worktree, so what the README says is what
// happens. The branch stays, so nothing already pushed is lost.
async function cancelRun(issue: GhIssue, deps: WatchDeps, config: FactoryConfig): Promise<Outcome> {
  const lifecycle = labelsOf(issue).filter((n) => n.startsWith("factory:") && n !== LABEL.monitor);
  if (lifecycle.length > 0) await deps.github.removeLabels(config.repo, issue.number, lifecycle);
  const head = deps.git.branchName(issue.number);
  const pr = await deps.github.findPrByHead(config.repo, head);
  if (pr) await deps.github.closePr(config.repo, pr.number);
  await postComment(
    deps,
    config,
    issue.number,
    `Cancelled by \`/factory cancel\`. The branch \`${head}\` is kept; label the issue \`${LABEL.ready}\` after deleting it to start over.`,
  );
  await deps.github.closeIssue(config.repo, issue.number);
  await runRetro(deps, config, issue, "rejected");
  await dropWorkspace(deps, issue.number);
  finish(deps, config, issue.number, "cancelled");
  return "cancelled";
}

// A run that is over needs its workspace no more; the branch keeps the work. A failed
// removal is logged, never fatal: the run's outcome is already decided.
async function dropWorkspace(deps: WatchDeps, issueNumber: number): Promise<void> {
  await deps.git
    .removeWorktree(deps.cloneDir, worktreeFor(deps, issueNumber))
    .catch((err) => console.error(`removing #${issueNumber}'s workspace failed:`, err));
}

// The runner's own data marker counts too: an agent that drops the marker line
// from question-comment.md would otherwise park the issue with no way to answer.
const RUNNER_QUESTION_MARKER = '<!-- factory:data {"stage":"question"';

function findQuestionComment(issue: GhIssue): GhComment | undefined {
  return [...issue.comments]
    .reverse()
    .find((c) => c.body.includes("<!-- factory:question v1 -->") || c.body.includes(RUNNER_QUESTION_MARKER));
}

function findPlanComment(issue: GhIssue): GhComment | undefined {
  return [...issue.comments].reverse().find((c) => isTrusted(c) && c.body.includes("<!-- factory:plan v1"));
}

function ctxFrom(deps: WatchDeps, issue: GhIssue): RunCtx {
  const derived = deriveIssueState(issue, workflowOf(deps, issue));
  return { rejectRound: derived.rejectRounds, questionRound: derived.questionRounds };
}

// A trusted reply newer than the open question resumes the same stage, with
// the reply appended as context (plan section 3). The stage to resume comes
// from deriveIssueState, not SQLite, so this works after a restart with an
// empty DB (audit finding #21).
export async function resumeNeedsInfo(
  issue: GhIssue,
  deps: WatchDeps,
  config: FactoryConfig,
): Promise<Outcome | undefined> {
  const question = findQuestionComment(issue);
  if (!question) return undefined;
  const reply = latestTrustedCommentAfter(issue.comments, question.createdAt);
  if (!reply || !(await commandIsTrusted(deps, config, reply))) return "waiting";
  if (parseChatOps(reply.body).type === "cancel") return cancelRun(issue, deps, config);

  const derived = deriveIssueState(issue, workflowOf(deps, issue));
  const worktree = worktreeFor(deps, issue.number);
  if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, LABEL.needsInfo))) return "needs-human";
  await Bun.write(`${worktree}/${runDir(issue.number)}/answer.md`, unsigned(reply.body));
  await deps.github.setStateLabel(
    config.repo,
    issue.number,
    [LABEL.needsInfo],
    labelOf(deps, issue, derived.resumeStage),
  );
  return runFromStage(deps, config, issue, derived.resumeStage, worktree, ctxFrom(deps, issue));
}

// `/factory approve|revise|retry|cancel` on a plan awaiting approval (plan
// section 4). A plain reply here is not a command and is ignored: only a
// question comment accepts a plain-text answer.
export async function resumeAwaitingApproval(
  issue: GhIssue,
  deps: WatchDeps,
  config: FactoryConfig,
): Promise<Outcome | undefined> {
  const plan = findPlanComment(issue);
  if (!plan) return undefined;
  const reply = latestTrustedCommentAfter(issue.comments, plan.createdAt);
  // The step that parked here names where approve and revise go.
  const parked = deriveIssueState(issue, workflowOf(deps, issue)).resumeStage;
  const edge = parkEdgeOf(workflowOf(deps, issue), parked);
  // Human on the loop: silence through the window approves; any trusted comment holds it for a person.
  const start = edge?.after === undefined ? undefined : parkWindowStart(issue.comments, parked, plan.createdAt);
  const lapsed = !reply && start !== undefined && (deps.now?.() ?? new Date()).getTime() - start >= edge!.after!;
  if (!lapsed && (!reply || !(await commandIsTrusted(deps, config, reply)))) return "waiting";
  const command = reply ? parseChatOps(reply.body) : ({ type: "approve" } as const);
  const worktree = worktreeFor(deps, issue.number);

  if (command.type === "cancel") return cancelRun(issue, deps, config);
  if (!edge) return "waiting";
  const resumeAt = async (stepId: string): Promise<Outcome> => {
    if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, LABEL.awaitingApproval)))
      return "needs-human";
    if (command.type === "revise" && reply) await writeRevision(worktree, issue, reply, command.text);
    await deps.github.setStateLabel(config.repo, issue.number, [LABEL.awaitingApproval], labelOf(deps, issue, stepId));
    return runFromStage(deps, config, issue, stepId, worktree, ctxFrom(deps, issue));
  };
  if (lapsed)
    await postComment(
      deps,
      config,
      issue.number,
      `No maintainer commented within the window, so the factory approved the plan.`,
    );
  if (command.type === "approve") return resumeAt(edge.approve);
  if (command.type === "revise" || command.type === "retry") return resumeAt(edge.revise);
  // A plain reply that is not a command: nothing to do yet.
  return "waiting";
}

// `/factory retry` on a `failed` or `needs-human` issue (audit finding #18):
// before this, both were dead ends. Resumes from whichever stage last
// posted a data marker, recovered by deriveIssueState.
export async function resumeParked(
  issue: GhIssue,
  deps: WatchDeps,
  config: FactoryConfig,
): Promise<Outcome | undefined> {
  const latest = issue.comments.filter((c) => isHumanComment(c)).at(-1);
  if (!latest) return undefined;
  const verb = parseChatOps(latest.body).type;
  // The caller hands over a writers-only thread (trustedThread), so this verb is a writer's.
  if (verb !== "cancel" && verb !== "retry") return undefined;
  if (verb === "cancel") return cancelRun(issue, deps, config);
  // A retry counts once: the runner acknowledges it below, so a run that parks again without a comment cannot replay it.
  const lastRunner = issue.comments.filter((c) => c.body.includes("<!-- factory:")).at(-1);
  if (lastRunner && Date.parse(lastRunner.createdAt) >= Date.parse(latest.createdAt)) return undefined;

  const currentLabel = labelsOf(issue).find((n) => n === LABEL.failed || n === LABEL.needsHuman);
  if (!currentLabel) return undefined;

  const derived = deriveIssueState(issue, workflowOf(deps, issue));
  const worktree = worktreeFor(deps, issue.number);
  if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, currentLabel))) return "needs-human";
  await deps.github.commentIssue(
    config.repo,
    issue.number,
    `Retrying from ${derived.resumeStage}.\n\n<!-- factory:retry v1 -->`,
  );
  await deps.github.setStateLabel(config.repo, issue.number, [currentLabel], labelOf(deps, issue, derived.resumeStage));
  return runFromStage(deps, config, issue, derived.resumeStage, worktree, {
    rejectRound: derived.rejectRounds,
    questionRound: 0, // a human asked for a retry; give it a fresh round of questions if needed
  });
}

// `/factory revise <text>` on an in-review issue (audit finding #19): sends
// the change back to build with the feedback as `revise.md`.
// One snapshot per poll, never waitForCi's sleep loop, which would hold a slot for 20 minutes. A
// routine miss (no PR, a transient error) leaves the PR for a human, as policy "off" does; runPool
// has no per-item error isolation, so nothing here may throw uncaught.
async function checkMergePolicy(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): Promise<Outcome | undefined> {
  try {
    const issueNumber = issue.number;
    const head = deps.git.branchName(issueNumber);
    const pr = await deps.github.findPrByHead(config.repo, head);
    if (!pr) return;
    await validatePr(deps.github, config.repo, issueNumber, pr.number);

    const [ci, readiness] = await Promise.all([
      ciStatusNow(deps.github, config.repo, pr.number),
      deps.github.mergeReadiness(config.repo, pr.number),
    ]);
    const worktree = worktreeFor(deps, issueNumber);
    // The PR head, not the worktree's: the policy judges the commit --match-head-commit merges.
    const changedFiles = await deps.git.diffStat(worktree, config.base, readiness.headRefOid);
    const plan = await readStageArtifacts(worktree, issueNumber, "plan");
    const auto = await mergeContext(deps, config, worktree, issueNumber, changedFiles, pr.number);
    const decision = decideMerge({
      readiness,
      ci,
      changedFiles,
      protectedPaths: config.protectedPaths,
      expectedBaseRefName: config.base,
      codeowners: codeownerCheck(config.profile, deps.cloneDir, readiness.approvedBy),
      ...tierInput(auto, config, (plan.json as Pick<PlanArtifact, "risk"> | undefined)?.risk),
    });

    const fresh = !issue.comments.some((c) => c.body.includes(mergePolicyMarker(decision.headSha)));
    const post = fresh ? (body: string) => postComment(deps, config, issueNumber, body) : undefined;
    const run = { worktree, pr: pr.number, branch: head, issue: issueNumber, post };
    const merged = await settleMerge(deps, config, auto, decision, run);
    if (merged) return await recordMerge(deps, config, issue, pr.number, "factory");
  } catch (err) {
    console.error(`merge-policy check failed for #${issue.number}:`, err);
  }
  return undefined;
}

export function mergedMarker(prNumber: number): string {
  return `<!-- factory:merged pr=${prNumber} -->`;
}

// Once per merged PR, whoever merged it: the marker comment is the guard, so a
// later poll that sees the same merged PR does nothing. A human merge also closes
// the issue, since a tracker other than GitHub only learns of it here (a factory
// merge already closed it in ComposedScm.mergePr); a GitHub issue that is already
// closed makes that close a no-op, and a failed close is logged, never fatal.
async function recordMerge(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  prNumber: number,
  by: "factory" | "human",
): Promise<Outcome> {
  const marker = mergedMarker(prNumber);
  if (issue.comments.some((c) => isTrusted(c) && c.body.includes(marker))) return "waiting";
  const who = by === "human" ? "by a human on the code host" : "by the merge policy";
  await postComment(deps, config, issue.number, `PR #${prNumber} was merged ${who}.\n\n${marker}`);
  if (by === "human") {
    await deps.github
      .closeIssue(config.repo, issue.number)
      .catch((err) => console.error(`closing #${issue.number} after its merge failed:`, err));
  }
  // Whatever state the run sat in: a parked run's PR can be merged by hand too.
  const lifecycle = labelsOf(issue).filter((n) => n.startsWith("factory:") && n !== LABEL.monitor);
  if (lifecycle.length > 0) await deps.github.removeLabels(config.repo, issue.number, lifecycle);
  emitEvent(
    deps.bus,
    "factory.pr.merged",
    { repo: config.repo, issue: issue.number, pr: prNumber, by },
    `issue/${issue.number}`,
  );
  await runRetro(deps, config, issue, "merged");
  await dropWorkspace(deps, issue.number);
  finish(deps, config, issue.number, "shipped");
  return "shipped";
}

// The issue's PR merged on the code host, whatever merge.policy says. Checked
// before human commands: a revise or cancel only means something on a PR that is
// still open. Like checkMergePolicy, a transient error leaves it for the next poll.
async function shipIfMerged(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): Promise<Outcome | undefined> {
  try {
    const pr = await deps.github.mergedPrByHead(config.repo, deps.git.branchName(issue.number));
    return pr ? await recordMerge(deps, config, issue, pr.number, "human") : undefined;
  } catch (err) {
    console.error(`merged-PR check failed for #${issue.number}:`, err);
    return undefined;
  }
}

export async function resumeInReview(
  issue: GhIssue,
  deps: WatchDeps,
  config: FactoryConfig,
): Promise<Outcome | undefined> {
  const merged = await shipIfMerged(deps, config, issue);
  if (merged) return merged;
  // Feedback counts only if it is newer than the runner's last marker
  // comment: a handled revise is followed by the rebuild's own verdict, so it
  // is never picked up twice. The draft PR's comments and reviews count too.
  const lastRunner = issue.comments.filter((c) => c.body.includes("<!-- factory:")).at(-1);
  const since = lastRunner ? Date.parse(lastRunner.createdAt) : 0;
  const prFeedback = await keepTrusted(
    deps,
    config,
    await deps.github.prFeedback(config.repo, deps.git.branchName(issue.number)),
  );
  const latest = [...issue.comments, ...prFeedback]
    .filter((c) => isHumanComment(c) && Date.parse(c.createdAt) > since)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1);
  if (latest && (await commandIsTrusted(deps, config, latest))) {
    const command = parseChatOps(latest.body);
    if (command.type === "cancel") return cancelRun(issue, deps, config);
    const reviseTo = stepByLabel(workflowOf(deps, issue), LABEL.inReview)?.revise;
    if (command.type === "revise" && reviseTo) {
      const worktree = worktreeFor(deps, issue.number);
      if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, LABEL.inReview))) return "needs-human";
      await writeRevision(worktree, issue, latest, command.text);
      const head = deps.git.branchName(issue.number);
      if (await deps.github.findPrByHead(config.repo, head)) await deps.github.markReady(config.repo, head, false);
      await deps.github.setStateLabel(config.repo, issue.number, [LABEL.inReview], labelOf(deps, issue, reviseTo));
      return runFromStage(deps, config, issue, reviseTo, worktree, ctxFrom(deps, issue));
    }
  }
  // A human command always wins over auto-merge, so this only runs once
  // there is nothing to revise or cancel.
  if (config.merge.policy !== "off" || config.merge.autonomy) return checkMergePolicy(deps, config, issue);
  return undefined;
}

// Every label a run waits on a human under, so its PR may have been merged by hand meanwhile.
const WAITING_LABELS: readonly string[] = [...PARKED_LABELS, LABEL.awaitingApproval];
const PARKED_STATUSES = new Set<string>(["needs-info", "awaiting-approval", "needs-human"]);

// A parked run whose issue was closed outside the factory drops out of every
// label list pollOnce reads, so nothing else would ever end it: its row stays
// parked and its tmux window open. Shipped if its PR merged, else cancelled.
// Each issue is held in inFlight while it is checked, so an overlapping poll
// never records it twice.
export async function reconcileClosed(
  deps: WatchDeps,
  config: FactoryConfig,
  listed: Set<number>,
  inFlight?: Set<number>,
): Promise<number[]> {
  const ended: number[] = [];
  for (const run of deps.state.listRuns(config.repo)) {
    if (!PARKED_STATUSES.has(run.status) || listed.has(run.issue) || inFlight?.has(run.issue)) continue;
    inFlight?.add(run.issue);
    try {
      const issue = await deps.github.getIssue(config.repo, run.issue);
      if (issue.state !== "CLOSED") continue;
      if ((await shipIfMerged(deps, config, issue)) !== "shipped") {
        await dropWorkspace(deps, issue.number);
        finish(deps, config, issue.number, "cancelled", "issue closed outside the factory");
      }
      ended.push(issue.number);
    } catch (err) {
      console.error(`reconciling closed #${run.issue} failed:`, err);
    } finally {
      release(inFlight, run.issue);
    }
  }
  return ended;
}

// The single entry point every mode drives through: the pool (watch), a
// one-off CLI call (`factory run --issue N`, for CI), and crash recovery all
// call this with nothing but the issue's current GitHub state.
// A run's final status lands after its last stage shipped, so changed rows ship once more here.
export async function advanceIssue(deps: WatchDeps, config: FactoryConfig, listed: GhIssue): Promise<Outcome> {
  const before = deps.state.getRun(config.repo, listed.number)?.updated_at;
  try {
    return await advanceListed(deps, config, listed);
  } finally {
    if (deps.state.getRun(config.repo, listed.number)?.updated_at !== before)
      await shipRunState(deps.blobs, deps.state, config.repo, listed.number);
  }
}

async function advanceListed(deps: WatchDeps, config: FactoryConfig, listed: GhIssue): Promise<Outcome> {
  const names = labelsOf(listed);
  // A fresh claim reads the live thread as stages post to it; nothing in it is a human command yet.
  if (names.includes(LABEL.ready)) return processReadyIssue(listed, deps, config);
  const issue = await trustedThread(deps, config, listed);
  // A parked run's PR merged by hand ships it; nothing else would, since only in-review checks.
  if (WAITING_LABELS.some((l) => names.includes(l)) && (await shipIfMerged(deps, config, issue)) === "shipped")
    return "shipped";
  if (names.includes(LABEL.needsInfo)) return (await resumeNeedsInfo(issue, deps, config)) ?? "waiting";
  if (names.includes(LABEL.awaitingApproval)) return (await resumeAwaitingApproval(issue, deps, config)) ?? "waiting";
  if (names.includes(LABEL.failed) || names.includes(LABEL.needsHuman))
    return (await resumeParked(issue, deps, config)) ?? "waiting";
  if (names.includes(LABEL.inReview)) return (await resumeInReview(issue, deps, config)) ?? "waiting";
  return "waiting";
}

// This process's own cap, narrowed to the machine's cap when one is configured (plan v2.7.0 item 5).
function dispatchConcurrency(deps: WatchDeps, config: FactoryConfig): number {
  return deps.machine ? effectiveSlots(config.concurrency, deps.machine.config) : config.concurrency;
}

// A lease before an issue advances keeps two watchers sharing one FACTORY_HOME under the machine's
// slot count, which each pool's own cap alone would not. No lease just means "waiting" until next poll.
async function dispatch(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): Promise<Outcome> {
  if (!deps.machine) return advanceIssue(deps, config, issue);
  const leaseId = deps.machine.leases.acquire(`${config.repo}#${issue.number}`, dispatchConcurrency(deps, config));
  if (leaseId === undefined) return "waiting";
  try {
    return await advanceIssue(deps, config, issue);
  } finally {
    deps.machine.leases.release(leaseId);
  }
}

// `inFlight` spans overlapping polls (plan v2.7.0 item 6), so a busy issue never reaches a second
// runPool. A poll that listed issues before one was released holds a stale copy and must skip it:
// `releasedAt` records when, in `releaseSeq` order. Absent, every poll is self-contained.
const releasedAt = new WeakMap<Set<number>, Map<number, number>>();
let releaseSeq = 0;

function release(inFlight: Set<number> | undefined, issue: number): void {
  if (!inFlight?.delete(issue)) return;
  const seqs = releasedAt.get(inFlight) ?? new Map<number, number>();
  releasedAt.set(inFlight, seqs);
  seqs.set(issue, ++releaseSeq);
}

export async function pollOnce(deps: WatchDeps, config: FactoryConfig, inFlight?: Set<number>): Promise<PollResult> {
  const listedAt = releaseSeq;
  const openPrs = await deps.github.listPrs(config.repo, { state: "open" });
  // STOP_IF, the auto_start switch and the spend caps pause new pickups only (src/dispatch.ts);
  // approvals, answers, retries and revises keep flowing so a human can clear the backlog.
  const gate = await intakeGate(deps, config, openPrs);
  const intakeGated = gate.open;
  if (deps.machine) deps.machine.leases.beat(machineBeat(deps.machine));
  // A schedule files its issue even while intake is paused; the issue waits in factory:ready.
  for (const workflow of allWorkflows(deps)) {
    const filed = await fireCron(deps.github, cronStore(deps), config.repo, workflow, deps.now?.() ?? new Date()).catch(
      (err) => (console.error("factory watch: cron trigger failed", err), [] as number[]),
    );
    for (const n of filed) await recordTriggered(deps, config, n, workflow, "on: cron:");
  }
  // A minion runs for minutes: started here, never awaited by the poll.
  for (const minion of dueCronMinions(deps.state, config.repo, deps.minions ?? [], deps.now?.() ?? new Date()))
    startMinion(deps, config, minion);
  const [readyRaw, needsInfo, awaitingApproval, failed, needsHuman, inReview, blockedRaw] = await Promise.all([
    intakeGated ? deps.github.listIssuesByLabel(config.repo, LABEL.ready) : Promise.resolve([]),
    deps.github.listIssuesByLabel(config.repo, LABEL.needsInfo),
    deps.github.listIssuesByLabel(config.repo, LABEL.awaitingApproval),
    deps.github.listIssuesByLabel(config.repo, LABEL.failed),
    deps.github.listIssuesByLabel(config.repo, LABEL.needsHuman),
    deps.github.listIssuesByLabel(config.repo, LABEL.inReview),
    intakeGated ? deps.github.listIssuesByLabel(config.repo, LABEL.blocked) : Promise.resolve([]),
  ]);

  // The dependency gate (blockers.ts), once per poll before any dispatch: a ready issue with an open
  // "Blocked by" moves to LABEL.blocked, and back to ready the poll its last blocker clears.
  const { clear } = await resolveBlockers(deps.github, config.repo, readyRaw, blockedRaw);
  // Per-team and org caps hold back new pickups while work waits on people (src/org-caps.ts).
  const ready = admitReady(clear, [...awaitingApproval, ...inReview], capsFor(config));
  const buckets = [ready, needsInfo, awaitingApproval, failed, needsHuman, inReview];

  const seen = new Set<number>();
  const candidates = buckets
    .flat()
    .filter((issue) => {
      if (seen.has(issue.number) || inFlight?.has(issue.number)) return false;
      if (!canServe(deps.machine?.config.capabilities, issue.labels)) return false;
      const released = inFlight ? releasedAt.get(inFlight)?.get(issue.number) : undefined;
      if (released !== undefined && released > listedAt) return false;
      seen.add(issue.number);
      return true;
    })
    // Oldest ticket first: tickets are filed in dependency order, and gh's
    // own list order is otherwise unspecified (audit: newest-first in
    // practice), which raced dependents ahead of what they were blocked on.
    .sort((a, b) => a.number - b.number);

  // candidates was filtered against inFlight above; mark them before any
  // await so an overlapping poll's own candidates filter (same check) never
  // sees this batch as still unclaimed.
  for (const issue of candidates) inFlight?.add(issue.number);

  // Drains retros the dashboard's operator-merge route queued (v2.10.0 item
  // 3); independent of intake, so it runs even while intake is paused.
  await runQueuedRetros(deps, config);

  try {
    // A pool of `concurrency` workers, not one-at-a-time and not
    // Promise.all-everything: before this, issue #4 never started until #1's
    // whole five-stage chain finished (audit finding #2).
    // Each issue leaves inFlight when its own dispatch ends: one that parks
    // (awaiting approval, a question) must be visible to the next poll while
    // a slower batch-mate still builds, or its human's reply sits unread.
    const outcomes = await runPool(candidates, dispatchConcurrency(deps, config), (issue) =>
      dispatch(deps, config, issue).finally(() => release(inFlight, issue.number)),
    );
    const processed = candidates
      .filter((_, i) => outcomes[i] && outcomes[i] !== "waiting")
      .map((issue) => issue.number);
    processed.push(...(await reconcileClosed(deps, config, new Set(buckets.flat().map((i) => i.number)), inFlight)));
    if (gate.paused) return { paused: true, reason: gate.paused, processed };
    return { paused: false, processed };
  } finally {
    for (const issue of candidates) inFlight?.delete(issue.number);
  }
}

// Re-drives any issue a crashed or restarted process left sitting in a
// running label — otherwise it just sits there forever, since none of those
// labels are ones pollOnce's resume functions look for (audit finding #21).
// Call once, before the first poll.
export async function recoverInFlight(deps: WatchDeps, config: FactoryConfig): Promise<number[]> {
  // Every label a step holds while it runs; a terminal step's (in-review) is a waiting state.
  const running = new Set(
    allWorkflows(deps).flatMap((w) =>
      Object.values(w.steps)
        .filter((s) => !STEP_TYPES[s.uses]!.terminal)
        .map((s) => s.label),
    ),
  );
  const lists = await Promise.all([...running].map((l) => deps.github.listIssuesByLabel(config.repo, l)));
  const issues = [...new Map(lists.flat().map((i) => [i.number, i])).values()].filter((i) =>
    canServe(deps.machine?.config.capabilities, i.labels),
  );
  await runPool(issues, dispatchConcurrency(deps, config), async (listed) => {
    const issue = await trustedThread(deps, config, listed);
    const derived = deriveIssueState(issue, workflowOf(deps, issue));
    const worktree = worktreeFor(deps, issue.number);
    if (!(await ensureWorktreeReady(deps, config, issue.number, worktree, labelOf(deps, issue, derived.resumeStage))))
      return "needs-human";
    return runFromStage(deps, config, issue, derived.resumeStage, worktree, {
      rejectRound: derived.rejectRounds,
      questionRound: derived.questionRounds,
    });
  });
  return issues.map((i) => i.number);
}

// Fires on a fixed cadence and never waits for the previous poll's whole
// batch to finish first (plan v2.7.0 item 6): before this, one long build
// held back every new pickup until its entire batch — not just its own
// stage — was done. A shared `inFlight` set is what makes that safe instead
// of a repeat of audit finding #2 (double-dispatch): an issue still being
// worked by an earlier, still-running poll is invisible to a newer one.
//
// A webhook delivery (dashboard/server.ts records it in the same SQLite file,
// from this process or the dashboard's own) polls straight away instead of
// waiting out the interval.
export const WEBHOOK_CHECK_MS = 2000;

export function startWatch(
  deps: WatchDeps,
  config: FactoryConfig,
  onTick?: (r: PollResult) => void,
  webhookCheckMs = WEBHOOK_CHECK_MS,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const inFlight = new Set<number>();
  let seenDelivery = deps.state.latestDelivery();
  // Another app's event only wakes the poll, which then applies every normal check (readyIsTrusted,
  // intake, caps). Nothing reads an issue or an actor out of event data.
  const unsubscribe = deps.bus?.subscribe("*", (e) =>
    handleEvent(deps, config, e).then((filed) => void ((filed > 0 || isExternalEventType(e.type)) && tick())),
  );

  function tick(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    pollOnce(deps, config, inFlight)
      .then((result) => onTick?.(result))
      .catch((err) => console.error("factory watch: poll failed", err));
    timer = setTimeout(tick, config.pollIntervalSeconds * 1000);
  }

  const webhooks = setInterval(() => {
    // POST /events rows the dashboard stored, then sinks whose retry is due.
    if (deps.bus) {
      deps.bus.drainInbound();
      void deps.bus.deliver();
    }
    const latest = deps.state.latestDelivery();
    if (latest === seenDelivery) return;
    seenDelivery = latest;
    tick();
  }, webhookCheckMs);

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(webhooks);
    unsubscribe?.();
  };
}

function startMinion(deps: WatchDeps, config: FactoryConfig, minion: Minion, event?: CloudEvent): void {
  void runMinion(deps, config, minion, event)
    .then(
      (r) => r.status !== "ok" && console.error(`factory watch: minion ${minion.name} ${r.status}: ${r.reason ?? ""}`),
    )
    .catch((err) => console.error(`factory watch: minion ${minion.name} failed`, err));
}

// Every event, emitted here or received on POST /events: file an issue for each
// workflow listening for its type, and start each minion it wakes. Returns how
// many issues it filed, so the watcher can poll for them at once.
export async function handleEvent(deps: WatchDeps, config: FactoryConfig, event: CloudEvent): Promise<number> {
  let filed = 0;
  for (const workflow of allWorkflows(deps)) {
    try {
      const n = await fireEvent(deps.github, config.repo, workflow, event);
      if (n === undefined) continue;
      filed++;
      await recordTriggered(deps, config, n, workflow, `on: event: ${event.type}`);
    } catch (err) {
      console.error(`factory watch: event trigger ${workflow.name} on ${event.type} failed`, err);
    }
  }
  for (const minion of minionsFor(deps.minions ?? [], event)) startMinion(deps, config, minion, event);
  return filed;
}
