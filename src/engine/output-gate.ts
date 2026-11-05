// Every step of a run writes through a tracker that screens the write (src/write-screen.ts) and, when the
// workflow declares `outputs:`, counts, prefixes and refuses what it did not declare (src/safe-outputs.ts).
// A refused write fails the step and a held one parks the run; both are recorded on it.

import type { StageName } from "../executor";
import type { ScmPort } from "../ports/scm";
import { gateScm, protectedFallbackBody, type Tally, WriteRefused } from "../safe-outputs";
import type { Stage } from "../state";
import { DEFAULT_HOSTS, describeFindings, ScreenHeld, screenScm, screenWrites } from "../write-screen";
import { postComment, stopStep } from "./common";
import { failStage } from "./failure";
import type { StepCtx, StepResult, StepType } from "./steps";

const tallies = new WeakMap<object, Tally>();

// Build found a protected path touched: with `on_protected_path: issue`, the change is filed as an issue
// carrying the diff (through the gated tracker, so the issue maximum, prefix and expiry apply) and no PR follows.
export async function protectedAsIssue(sc: StepCtx, hits: readonly string[]): Promise<StepResult | undefined> {
  const { deps, config, issue, worktree, step, workflow } = sc;
  if (!workflow.outputs?.pull_request?.onProtectedPath) return undefined;
  const title = `Protected paths: ${issue.title}`;
  const body = protectedFallbackBody(title, hits, await deps.git.diff(worktree, config.base));
  const filed = await deps.github.createIssue(config.repo, title, body, []);
  await postComment(
    deps,
    config,
    issue.number,
    `No pull request will be opened: the change touches protected paths. The diff is on #${filed}.`,
  );
  return {
    kind: "stop",
    outcome: await stopStep(deps, config, issue.number, step.label, {
      status: "needs-human",
      reason: `protected paths: filed #${filed} instead of a PR`,
    }),
  };
}

// A hold: the write that failed the screen was not made. The run is labelled for a person, with each finding named.
async function held(sc: StepCtx, e: ScreenHeld): Promise<StepResult> {
  const { deps, config, issue, step } = sc;
  const run = deps.state.getRun(config.repo, issue.number);
  const what = describeFindings(e.findings);
  if (run) deps.state.appendEvent(run.id, step.uses as Stage, "write_held", what);
  await postComment(
    deps,
    config,
    issue.number,
    `Held for a person: what this run planned to write failed the screen, so nothing more of it was applied.\n\n${what}`,
  );
  const reason = `held by the write screen: ${e.findings.length} finding(s)`;
  return {
    kind: "stop",
    outcome: await stopStep(deps, config, issue.number, step.label, { status: "needs-human", reason }),
  };
}

// Runs one step of a run with the tracker it may write through: screened always, and counted and
// refused against `outputs:` when the workflow declares them.
export async function runGated(type: StepType, sc: StepCtx): Promise<StepResult> {
  const { deps, config, issue, worktree, step } = sc;
  const outputs = sc.workflow?.outputs;
  const hosts = [...DEFAULT_HOSTS, ...(sc.workflow?.allowedHosts ?? [])];
  const diff = () => deps.git.diff(worktree, config.base);
  let github: ScmPort = deps.github;
  if (outputs) {
    const tally = tallies.get(sc.ctx) ?? new Map();
    tallies.set(sc.ctx, tally);
    github = gateScm(github, outputs, tally, issue.number, deps.now ?? (() => new Date()));
  }
  try {
    // The pr step posts its receipt before it opens the PR, so the diff is screened before it starts.
    if (step.uses === "pr") {
      const screen = screenWrites({ diff: await diff() }, hosts);
      if (screen.verdict === "hold") throw new ScreenHeld(screen.findings);
    }
    return await type.run({ ...sc, deps: { ...deps, github: screenScm(github, hosts, diff) } });
  } catch (e) {
    if (e instanceof ScreenHeld) return held(sc, e);
    if (!(e instanceof WriteRefused)) throw e;
    const run = deps.state.getRun(config.repo, issue.number);
    if (run) deps.state.appendEvent(run.id, step.uses as Stage, "write_refused", e.message);
    const cause = `write refused: ${e.message}`;
    return { kind: "stop", outcome: await failStage(deps, config, issue, step.label, step.uses as StageName, cause) };
  }
}
