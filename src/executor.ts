// The stage contract: types, result aggregation and the replay executor that
// `bun test` uses (no model, no network). Real agents run through
// src/agents/executor.ts; the Claude and Codex line parsers live in
// src/agents/presets/.

import { truncateFinalMessage } from "./agents/final-message";
import { parseStreamJsonLine } from "./agents/presets/claude";

import {
  OPERATOR_TAKEOVER,
  type StageName,
  type StageEvent,
  type StageRunOptions,
  type StageRunResult,
  type Executor,
  type Refusal,
} from "./ports/agent";
export { OPERATOR_TAKEOVER };
export type { StageName, StageEvent, StageRunOptions, StageRunResult, Executor, Refusal };

export function aggregateStageEvents(events: StageEvent[], exitCode: number, stderrTail?: string): StageRunResult {
  let toolCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let costReported = false;
  let tokensCached = 0;
  let tokensCacheWrite = 0;
  const permissionDenials: string[] = [];
  const denied: NonNullable<StageEvent["denied"]>[number][] = [];
  const refusedBy = new Map<string, string>();
  let finalText: string | undefined;
  let sessionId: string | undefined;
  let final: { in: number; out: number; cached: number; cacheWrite: number } | "invalid" | undefined;
  for (const e of events) {
    if (e.finalText !== undefined) finalText = e.finalText;
    if (e.sessionId !== undefined) sessionId = e.sessionId;
    if (e.kind === "tool_use") toolCalls += 1;
    if (e.kind === "usage") {
      if (e.invalid) final = "invalid";
      else if (e.total)
        final = {
          in: e.tokensIn ?? 0,
          out: e.tokensOut ?? 0,
          cached: e.tokensCached ?? 0,
          cacheWrite: e.tokensCacheWrite ?? 0,
        };
      else {
        tokensIn += e.tokensIn ?? 0;
        tokensOut += e.tokensOut ?? 0;
        tokensCached += e.tokensCached ?? 0;
        tokensCacheWrite += e.tokensCacheWrite ?? 0;
      }
    }
    if (e.kind === "result") {
      if (e.costUsd !== undefined) {
        costUsd = e.costUsd;
        costReported = true;
      }
      permissionDenials.push(...(e.denials ?? []));
      denied.push(...(e.denied ?? []));
    }
    if (e.kind === "refusal" && e.toolUseId && e.refusedBy) refusedBy.set(e.toolUseId, e.refusedBy);
  }
  if (final === "invalid") {
    tokensIn = 0;
    tokensOut = 0;
    tokensCached = 0;
    tokensCacheWrite = 0;
  } else if (final) {
    tokensIn = final.in;
    tokensOut = final.out;
    tokensCached = final.cached;
    tokensCacheWrite = final.cacheWrite;
  }
  const finalMessage = finalText === undefined ? undefined : truncateFinalMessage(finalText);
  const result = {
    events,
    toolCalls,
    tokensIn,
    tokensOut,
    tokensCached,
    tokensCacheWrite,
    costUsd,
    costReported,
    exitCode,
    permissionDenials,
    // A denial no hook claimed is the permission rules': under dontAsk, the stage's allow list.
    ...(denied.length
      ? {
          refusals: denied.map((d) => ({
            tool: d.tool,
            target: d.target,
            by: refusedBy.get(d.id ?? "") ?? "allowlist",
          })),
        }
      : {}),
    usageComplete: final !== "invalid",
    ...(finalMessage ? { finalMessage } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  return exitCode !== 0 && stderrTail ? { ...result, stderrTail } : result;
}

// Fixture-driven, deterministic, no network. Keyed by "<stage>:<issue>" -> an
// array of raw stream-json lines, exactly what a recorded `claude` run wrote.
export class ReplayExecutor implements Executor {
  constructor(private readonly fixtures: Record<string, string[]>) {}

  static fromLines(stage: StageName, issue: number, lines: string[]): ReplayExecutor {
    return new ReplayExecutor({ [`${stage}:${issue}`]: lines });
  }

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    const key = `${opts.stage}:${opts.issue}`;
    const lines = this.fixtures[key];
    if (!lines) throw new Error(`replay: no fixture recorded for ${key}`);
    const events = lines.flatMap((l) => parseStreamJsonLine(l));
    return aggregateStageEvents(events, 0);
  }
}
