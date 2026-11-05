// A cancelled ci run that nothing superseded is restarted (#567). A push to the same ref cancels the older
// run on purpose, so only a run whose head is still the PR's head, and that is under the attempt cap, reruns.
import type { CommandRunner } from "./github";

export const MAX_ATTEMPTS = 3;

export interface CiRun {
  readonly conclusion: string | null;
  readonly headSha: string;
  readonly attempt: number;
  readonly pr: number | undefined;
}

export type RerunDecision = { rerun: true } | { rerun: false; reason: string };

export function decideRerun(run: CiRun, prHeadSha: string | undefined): RerunDecision {
  if (run.conclusion !== "cancelled") return { rerun: false, reason: "the run was not cancelled" };
  if (run.pr === undefined || prHeadSha === undefined) return { rerun: false, reason: "the run belongs to no open PR" };
  if (run.headSha !== prHeadSha) return { rerun: false, reason: "a newer push superseded the run" };
  if (run.attempt >= MAX_ATTEMPTS) return { rerun: false, reason: `the run already had ${run.attempt} attempts` };
  return { rerun: true };
}

async function api<T>(gh: CommandRunner, args: string[]): Promise<T> {
  const r = await gh.run(["api", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`gh api ${args.join(" ")} failed: ${r.stderr.trim() || "timed out"}`);
  return JSON.parse(r.stdout || "null") as T;
}

// Reads the run and its PR, decides, and reruns. Returns the decision so the workflow log says why.
export async function rerunIfCancelled(gh: CommandRunner, repo: string, runId: number): Promise<RerunDecision> {
  const raw = await api<{
    conclusion: string | null;
    head_sha: string;
    run_attempt: number;
    pull_requests?: { number: number }[];
  }>(gh, [`repos/${repo}/actions/runs/${runId}`]);
  const pr = raw.pull_requests?.[0]?.number;
  const open =
    pr === undefined
      ? undefined
      : await api<{ state: string; head: { sha: string } }>(gh, [`repos/${repo}/pulls/${pr}`]);
  const run = { conclusion: raw.conclusion, headSha: raw.head_sha, attempt: raw.run_attempt, pr };
  const decision = decideRerun(run, open?.state === "open" ? open.head.sha : undefined);
  if (decision.rerun) await api(gh, ["-X", "POST", `repos/${repo}/actions/runs/${runId}/rerun`]);
  return decision;
}
