// Walks a workflow from one step until the issue stops: a step parks or
// finishes it, or a park edge hands it to a human. Called for a fresh
// factory:ready pickup, a resume or a retry; `ctx` carries the round counts
// deriveIssueState recovered, so a resumed run doesn't reset the caps.

import type { FactoryConfig } from "../config";
import { OPERATOR_TAKEOVER } from "../executor";
import { evalExpr } from "../core/expr";
import type { Edge, Step, Workflow } from "../core/workflow";
import { latestDataFor, parseDataMarkers } from "../derive";
import type { GhIssue } from "../github";
import { LABEL } from "../labels";
import { McpError } from "../mcp";
import { checkSpendCap, finish, moveLabel, OperatorTakeover, postComment, stopStep, type Outcome, type RunCtx, type WatchDeps } from "./common";
import { RuntimeMissing, STEP_TYPES } from "./steps";
import { emitEvent } from "./bus";

// Outcomes that leave the issue waiting on a person; each emits factory.issue.parked.
const PARKED: ReadonlySet<Outcome> = new Set(["needs-info", "needs-human", "awaiting-approval", "failed"]);
// Outcomes where this worker did not run the issue to a stop, so no run ended.
const NOT_A_RUN: ReadonlySet<Outcome> = new Set(["waiting", "lost-claim", "untrusted"]);

export async function runWorkflow(
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  startStep: string,
  worktree: string,
  ctx: RunCtx = { rejectRound: 0, questionRound: 0 },
): Promise<Outcome> {
  if (!workflow.steps[startStep]) throw new Error(`workflow ${workflow.name} has no step "${startStep}"`);
  const at = { step: startStep };
  const base = { repo: config.repo, issue: issue.number, workflow: workflow.name };
  const subject = `issue/${issue.number}`;
  let outcome: Outcome;
  try {
    outcome = await walk(deps, config, workflow, issue, at, worktree, ctx);
  } catch (e) {
    emitEvent(deps.bus, "factory.step.failed", { ...base, step: at.step, error: e instanceof Error ? e.message : String(e) }, subject);
    throw e;
  }
  if (PARKED.has(outcome)) emitEvent(deps.bus, "factory.issue.parked", { ...base, step: at.step, outcome }, subject);
  if (!NOT_A_RUN.has(outcome)) emitEvent(deps.bus, "factory.run.completed", { ...base, step: at.step, outcome }, subject);
  return outcome;
}

async function walk(
  deps: WatchDeps,
  config: FactoryConfig,
  workflow: Workflow,
  issue: GhIssue,
  at: { step: string },
  worktree: string,
  ctx: RunCtx,
): Promise<Outcome> {
  let step: Step = workflow.steps[at.step]!;
  const base = { repo: config.repo, issue: issue.number, workflow: workflow.name };
  const subject = `issue/${issue.number}`;
  const issueNumber = issue.number;
  // What `if:` reads: each step's JSON, seeded from the thread so a resumed run sees earlier steps.
  const markers = parseDataMarkers(issue.comments);
  const facts: Record<string, unknown> = {};
  for (const id of Object.keys(workflow.steps)) {
    const seen = latestDataFor(markers, id);
    if (seen !== undefined) facts[id] = seen;
  }

  try {
    for (;;) {
      // The lease lapsed and another worker may hold it now: stop here, between steps, with the label as it is.
      if (deps.leases?.held.get(issueNumber)?.lost) return "waiting";
      const overBudget = await checkSpendCap(deps, config, issueNumber);
      if (overBudget) {
        // The amounts are operator detail: the inbox and the hidden marker carry them, the visible text does not.
        await postComment(deps, config, issueNumber, "Parked: a spend cap is reached. An operator can raise it and `/factory retry`.", { stage: "budget", json: { reason: overBudget } });
        return await stopStep(deps, config, issueNumber, step.label, { status: "needs-human", reason: overBudget });
      }
      at.step = step.id;
      emitEvent(deps.bus, "factory.step.started", { ...base, step: step.id, uses: step.uses }, subject);
      const result = await STEP_TYPES[step.uses]!.run({ deps, config, issue, worktree, ctx, step, workflow });
      if (result.kind === "stop" && result.outcome === "failed") emitEvent(deps.bus, "factory.step.failed", { ...base, step: step.id, outcome: result.outcome }, subject);
      else emitEvent(deps.bus, "factory.step.completed", { ...base, step: step.id, result: result.kind === "stop" ? result.outcome : result.kind }, subject);
      if (result.kind === "stop") return result.outcome;
      if (result.kind === "reject") {
        const back: Step = workflow.steps[step.reject!]!;
        await moveLabel(deps, config, issueNumber, step.label, back.label);
        step = back;
        continue;
      }
      if (result.facts !== undefined) facts[step.id] = result.facts;
      const edge = pickEdge(step.next, {
        ...facts,
        toggles: { autoApproveLowRisk: deps.state.getToggle("auto_approve_low_risk", config.riskPolicy.autoApproveLowRisk) },
        config,
      });
      if ("park" in edge) {
        await moveLabel(deps, config, issueNumber, step.label, LABEL.awaitingApproval);
        finish(deps, config, issueNumber, "awaiting-approval");
        return "awaiting-approval";
      }
      const to: Step = workflow.steps[edge.to]!;
      await moveLabel(deps, config, issueNumber, step.label, to.label);
      step = to;
    }
  } catch (e) {
    if (e instanceof McpError || e instanceof RuntimeMissing) emitEvent(deps.bus, "factory.step.failed", { ...base, step: step.id, error: e.message }, subject);
    if (e instanceof McpError) {
      // A server the step names is not in the base branch's .factory/mcp.json: nothing ran, so a retry after the fix is free.
      await postComment(deps, config, issueNumber, `Stopped before ${step.id}: ${e.message}. Add it to .factory/mcp.json or drop it from the step, then \`/factory retry\`.`, { stage: "mcp", json: { step: step.id, problem: e.message } });
      return await stopStep(deps, config, issueNumber, step.label, { status: "failed", reason: e.message });
    }
    if (e instanceof RuntimeMissing) {
      await postComment(deps, config, issueNumber, `Stopped before ${step.id}: ${e.message}. Add it to FACTORY_HOME/machine.json runtimes or drop it from the step, then \`/factory retry\`.`, { stage: "runtime", json: { step: step.id, problem: e.message } });
      return await stopStep(deps, config, issueNumber, step.label, { status: "failed", reason: e.message });
    }
    if (!(e instanceof OperatorTakeover)) throw e;
    // Not a failure and not a retry: the operator owns the session now, and
    // `/factory retry` (or `factory takeover`'s hand-back) re-enters this step.
    await moveLabel(deps, config, issueNumber, step.label, LABEL.needsHuman);
    await postComment(
      deps,
      config,
      issueNumber,
      `Taken over by an operator during ${step.id}. Comment \`/factory retry\` to hand it back; the factory resumes at ${step.id} with whatever is in the worktree.`,
      { stage: "takeover", json: { stage: step.id } },
    );
    finish(deps, config, issueNumber, "needs-human", OPERATOR_TAKEOVER);
    return "needs-human";
  }
}

// The first edge whose `if:` holds; parseWorkflow guarantees the last has none.
function pickEdge(edges: readonly Edge[], scope: Readonly<Record<string, unknown>>): Edge {
  return edges.find((e) => !e.if || Boolean(evalExpr(e.if, scope)))!;
}

// The park edge of the step an issue awaiting approval parked on, for /factory approve and revise.
export function parkEdgeOf(workflow: Workflow, stepId: string): Extract<Edge, { park: string }> | undefined {
  return workflow.steps[stepId]?.next.find((e): e is Extract<Edge, { park: string }> => "park" in e);
}
