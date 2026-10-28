// Why a stage failed, in one line an operator can act on (#91), and the guard that refuses a blind
// retry once the same failure repeated with nothing changed (#86). kaas.team#5 retried plan three
// times into one hook refusal, $0.30 each, under a reason that named neither the part nor the hook.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { scrubLine } from "../agents/record";
import type { FactoryConfig } from "../config";
import { parseDataMarkers } from "../derive";
import type { Refusal, StageName, StageRunResult } from "../executor";
import type { GhIssue } from "../github";
import { LABEL } from "../labels";
import { stageAllowRules, uncoveredPart } from "../stage-permissions";
import { EPOCH, finish, moveLabel, postComment, type WatchDeps } from "./common";

const FAILURE = "failure";
const PART_CHARS = 120;

const cap = (text: string, n: number) => {
  const line = text.trim().split("\n")[0]!;
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// A denial no preset classified (a test fixture, another agent) is "Tool target", refused by the allow list.
function refusalsOf(result: StageRunResult): readonly Refusal[] {
  if (result.refusals?.length) return result.refusals;
  return result.permissionDenials.map((d) => {
    const at = d.indexOf(" ");
    return at < 0
      ? { tool: d, target: "", by: "allowlist" }
      : { tool: d.slice(0, at), target: d.slice(at + 1), by: "allowlist" };
  });
}

// The last refused call, named down to the part of a compound command the allow list does not cover.
function refusalText(r: Refusal, allow: readonly string[]): string {
  const part = r.tool === "Bash" ? (uncoveredPart(r.target, allow) ?? r.target) : `${r.tool} ${r.target}`.trim();
  return `\`${cap(part, PART_CHARS)}\` refused by ${r.by}`;
}

// Most specific first: the stage's own JSON problem, a kill, a refused call,
// what the agent printed to stderr, then red gates and the stage's fallback.
export function stageCause(
  config: FactoryConfig,
  issueNumber: number,
  stage: StageName,
  result: StageRunResult,
  opts: { problem?: string; gate?: { status: string; failedGates: readonly string[] }; fallback?: string },
): string {
  if (opts.problem) return opts.problem;
  if (result.killedReason) return result.killedReason;
  const refused = refusalsOf(result).at(-1);
  if (refused) return refusalText(refused, stageAllowRules(stage, issueNumber, config.agentCommands));
  if (result.stderrTail) return result.stderrTail;
  const gates = opts.gate?.failedGates ?? [];
  if (gates.length) return `the change refused by ${gates.map((g) => `gate:${g}`).join(", ")}`;
  return opts.gate ? `gates ${opts.gate.status.toLowerCase()}` : (opts.fallback ?? `${stage} failed`);
}

// `<stage> attempt <n>: <cause>; spent $x on this issue`. The spend is operator detail, so only runs.reason
// (the dashboard row) carries it; the issue comment gets `visible`. The fingerprint is stage and cause alone.
export async function failureLine(
  deps: WatchDeps,
  config: FactoryConfig,
  issueNumber: number,
  stage: StageName,
  cause: string,
): Promise<{ line: string; visible: string; fingerprint: string }> {
  const attempt = deps.state.listStageRuns(config.repo, { issue: issueNumber }).filter((r) => r.stage === stage).length;
  const local = deps.state.spendSummary(config.repo, EPOCH, issueNumber).costUsd;
  const spent = Math.max(local, (await deps.spend?.issue(issueNumber))?.costUsd ?? 0);
  const visible = `${stage} attempt ${Math.max(attempt, 1)}: ${cap(cause, 400)}`;
  return {
    line: `${visible}; spent $${spent.toFixed(2)} on this issue`,
    visible,
    fingerprint: `${stage}: ${cap(cause, 200)}`,
  };
}

// What an operator changes to fix a cause: the repo's config.json, the issue body, this machine's machine.json.
function inputsOf(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): string {
  const seen = JSON.stringify([config, issue.body ?? "", deps.machine?.config ?? null]);
  return createHash("sha256").update(seen).digest("hex").slice(0, 16);
}

// A failed stage: the label, the reason line, and a comment whose marker carries the fingerprint the retry guard compares.
export async function failStage(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  from: string,
  stage: StageName,
  cause: string,
): Promise<"failed"> {
  const { line, visible, fingerprint } = await failureLine(deps, config, issue.number, stage, cause);
  await moveLabel(deps, config, issue.number, from, LABEL.failed);
  finish(deps, config, issue.number, "failed", line);
  await postComment(deps, config, issue.number, `Failed: ${visible}\n\n\`/factory retry\` runs it again.`, {
    stage: FAILURE,
    json: { fingerprint, inputs: inputsOf(deps, config, issue) },
  });
  return "failed";
}

// A refused push: git's last 20 lines on the thread, scrubbed of credentials (a remote URL can carry a token)
// and local paths, then the failure. A failed post must not keep failStage from parking the issue.
export async function failPush(
  deps: WatchDeps,
  config: FactoryConfig,
  issue: GhIssue,
  from: string,
  worktree: string,
  stderr: string,
): Promise<"failed"> {
  const lines = scrubLine(stderr.trim(), process.env, [homedir(), worktree])
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1<redacted>@")
    .split("\n");
  const tail = lines.slice(-20).join("\n");
  // Longer than any backtick run in the tail, so stderr cannot close the fence early.
  const fence = "`".repeat(Math.max(3, ...(tail.match(/`+/g) ?? []).map((run) => run.length + 1)));
  if (lines.some(Boolean))
    await postComment(deps, config, issue.number, `${fence}\n${tail}\n${fence}`).catch(() => undefined);
  return failStage(deps, config, issue, from, "build", `push_refused: ${lines.at(-1) ?? ""}`);
}

// The fingerprint the last two failures share, when nothing an operator could have fixed changed since.
export function repeatedCause(deps: WatchDeps, config: FactoryConfig, issue: GhIssue): string | undefined {
  const [prev, last] = parseDataMarkers(issue.comments)
    .filter((m) => m.stage === FAILURE)
    .slice(-2)
    .map((m) => (m.json ?? {}) as { fingerprint?: string; inputs?: string });
  if (!prev || !last?.fingerprint || prev.fingerprint !== last.fingerprint) return undefined;
  return last.inputs === inputsOf(deps, config, issue) ? last.fingerprint : undefined;
}

// True when the retry was refused: the comment is a runner comment, so the same retry is never replayed.
export async function refuseRepeat(deps: WatchDeps, config: FactoryConfig, issue: GhIssue, force: boolean) {
  const cause = force ? undefined : repeatedCause(deps, config, issue);
  if (!cause) return false;
  await postComment(
    deps,
    config,
    issue.number,
    `cause unchanged: ${cause}\n\nThe last two attempts failed the same way, and config.json, the issue body and machine.json have not changed since, so no stage ran. Fix the cause, or comment \`/factory retry --force\` to run it anyway.`,
  );
  return true;
}
