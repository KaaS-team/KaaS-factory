// `uses: skill`: runs one named skill as an agent step, read-only like a minion, and goes on when it
// answers {"ok": true}. `uses: gate` with `gate: human` pauses on its park edge for a person:
// /factory approve goes on, /factory revise <text> steers, /factory skip jumps past.

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "../artifacts";
import { configHash } from "../team/hash";
import { resolveSkill } from "../harness-defaults";
import { LABEL } from "../labels";
import type { Stage } from "../state";
import { finish, moveLabel, postComment, priceResult, recordSpend } from "./common";
import { MINION_STAGE, minionOutput } from "./minion";
import type { StepCtx, StepResult, StepType } from "./steps";

const stop = (outcome: "failed"): StepResult => ({ kind: "stop", outcome });

async function fail(sc: StepCtx, why: string): Promise<StepResult> {
  const { deps, config, issue, step } = sc;
  await postComment(deps, config, issue.number, `Step \`${step.id}\` failed: ${why}.`, {
    stage: step.id,
    json: { ok: false },
  });
  await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
  finish(deps, config, issue.number, "failed", `${step.id}: ${why}`);
  return stop("failed");
}

export const skillPrompt = (body: string, issueNumber: number, title: string, out: string): string =>
  [
    body.replace(/^---\n[\s\S]*?\n---\n/, "").trim(),
    `\n\n---\nIssue #${issueNumber}: ${title}\n`,
    `Change nothing in the repo. Write your answer as one JSON object {"ok": true|false, "summary": "..."} to ${out}, or make it your final message.`,
  ].join("\n");

export const skillStep: StepType = {
  agent: true,
  skill: true,
  async run(sc) {
    const { deps, config, issue, worktree, step } = sc;
    const found = resolveSkill(deps.cloneDir, step.skill!);
    if (!found)
      return fail(sc, `the skill \`${step.skill}\` is in neither the repo's skill directories nor the defaults`);
    const out = join(runDir(issue.number), `${step.id}.json`);
    mkdirSync(join(worktree, runDir(issue.number)), { recursive: true });
    const startedAt = new Date();
    const result = await deps.executor.runStage({
      stage: MINION_STAGE,
      issue: issue.number,
      cwd: worktree,
      maxBudgetUsd: config.maxBudgetUsd.retro,
      timeoutMinutes: step.timeoutMinutes ?? config.stageTimeoutMinutes,
      maxToolCalls: config.maxToolCalls,
      prompt: skillPrompt(readFileSync(found.path, "utf8"), issue.number, issue.title, out),
      ...(step.agent ? { agent: step.agent } : {}),
    });
    const finishedAt = new Date();
    const { cached, costUsd, usageComplete } = priceResult(result);
    deps.state.recordStageRun({
      repo: config.repo,
      issue: issue.number,
      stage: `skill:${step.skill}` as Stage,
      agent: result.agent ?? "claude",
      model: result.model ?? null,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      tool_calls: result.toolCalls,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      tokens_cached: cached,
      cost_usd: costUsd,
      usage_complete: usageComplete ? 1 : 0,
      exit_code: result.exitCode,
      killed_reason: result.killedReason ?? null,
      session_id: result.sessionId ?? null,
      config_hash: configHash(config),
    });
    await recordSpend(deps, config, {
      issue: issue.number,
      stage: `skill:${step.skill}`,
      costUsd,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      at: startedAt.toISOString(),
    });
    if (result.exitCode !== 0 || result.killedReason)
      return fail(sc, result.killedReason ?? `the agent exited ${result.exitCode}`);
    const answer = minionOutput(join(worktree, out), result.finalMessage) as
      | { ok?: unknown; summary?: unknown }
      | undefined;
    if (answer?.ok !== true) {
      const why =
        typeof answer?.summary === "string" && answer.summary ? answer.summary : "the skill gave no ok answer";
      return fail(sc, `the skill \`${step.skill}\` did not pass: ${why}`);
    }
    return { kind: "next", facts: { ok: true, summary: typeof answer.summary === "string" ? answer.summary : "" } };
  },
};

export const humanGate: StepType = {
  gate: true,
  async run(sc) {
    const { deps, config, issue, step } = sc;
    const edge = step.next.find((e): e is Extract<typeof e, { park: string }> => "park" in e)!;
    await postComment(
      deps,
      config,
      issue.number,
      `Waiting for a person at \`${step.id}\`. \`/factory approve\` goes on to ${edge.approve}, \`/factory revise <what to change>\` steers back to ${edge.revise}, \`/factory skip\` jumps to ${edge.skip}.`,
      { stage: step.id, json: { gate: "human" } },
    );
    return { kind: "next", facts: { gate: "human" } };
  },
};
