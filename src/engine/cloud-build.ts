// Cloud build path: hand the planned body to a provider, pull its commits, grade locally.

import { EnvSecrets } from "../adapters/env/secrets";
import { cloudLedger, cloudProvider, CloudError, TERMINAL, type CloudProvider, type CloudStatus } from "../cloud";
import { runGates } from "../gates";
import { orchestrateActive, orchestrateOf, type Orchestrate } from "../orchestrate/config";
import type { StageRunResult } from "../ports/agent";
import type { SecretsPort } from "../ports/secrets";
import type { Stage } from "../state";
import { configHash } from "../team/hash";
import { finishBuild } from "./build-tail";
import { failStage, stageCause } from "./failure";
import { postComment, stopStep, type Outcome } from "./common";
import type { StepCtx, StepResult, StepType } from "./steps";

const AUTH_COMMENT =
  "The cloud build could not start on this machine. A maintainer can check the factory setup and press retry.";

const CLOUD_OK: StageRunResult = {
  events: [],
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  exitCode: 0,
  permissionDenials: [],
};

const stop = (outcome: Outcome): StepResult => ({ kind: "stop", outcome });

export interface CloudIo {
  secrets: SecretsPort;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  provider?: (name: string, orch: Orchestrate) => CloudProvider | undefined;
  /** When set, overrides orchestrateActive for tests. */
  orchestrate?: boolean;
}

export function defaultCloudIo(): CloudIo {
  return {
    secrets: new EnvSecrets(),
    fetch: globalThis.fetch.bind(globalThis),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    pollMs: 30_000,
  };
}

export function cloudPrompt(issueBody: string, branch: string, protectedPaths: readonly string[]): string {
  const paths =
    protectedPaths.length > 0 ? protectedPaths.map((p) => `- ${p}`).join("\n") : "- (none beyond .factory/)";
  return `${issueBody}

Work only on branch \`${branch}\`.
Commit and push there.
Run the repo's gates before finishing.
Do not open a pull request.
Do not edit \`.factory/\` or these protected paths:
${paths}`;
}

function resolveProvider(name: string, orch: Orchestrate, io: CloudIo): CloudProvider | undefined {
  if (io.provider) return io.provider(name, orch);
  return cloudProvider(name, orch, io);
}

export function cloudAware(local: StepType, io: CloudIo = defaultCloudIo()): StepType {
  return {
    ...local,
    async run(sc): Promise<StepResult> {
      const { deps, config, issue, worktree, step } = sc;
      const n = issue.number;
      const ledger = cloudLedger(deps.state, config.repo);
      const res = ledger.reservation(n);
      const orch = orchestrateOf(config);
      const active = io.orchestrate ?? orchestrateActive(deps.state, config);
      const provider = res && active ? resolveProvider(res.provider, orch, io) : undefined;

      if (!res || !active || !provider) {
        if (res) ledger.release(n);
        return local.run(sc);
      }

      const providerSpec = orch.providers[res.provider];
      const model = providerSpec?.model ?? "auto";
      const timeoutMs = (providerSpec?.timeoutMinutes ?? 90) * 60_000;
      const deadline = res.at + timeoutMs;

      try {
        let before: string;
        let runId: string;
        let summary: string | undefined;
        let status: CloudStatus;
        try {
          ({ before, runId, summary, status } = await startCloudRun(sc, ledger, provider, model));
        } catch (err) {
          if (err instanceof CloudError && err.kind === "auth") {
            await postComment(deps, config, n, AUTH_COMMENT);
            return stop(await stopStep(deps, config, n, step.label, { status: "needs-human", reason: err.message }));
          }
          const cause = err instanceof Error ? err.message : "the cloud build could not start";
          return stop(await failStage(deps, config, issue, step.label, "build", cause));
        }

        let lastCost: number | undefined;
        let killedReason: string | null = null;
        const startedMs = io.now();

        while (!TERMINAL.has(status)) {
          if (io.now() >= deadline) {
            killedReason = "the cloud build ran past its time limit";
            await provider.cancel(runId);
            status = "cancelled";
            break;
          }
          await io.sleep(io.pollMs);
          const polled = await provider.poll(runId);
          status = polled.status;
          if (polled.summary) summary = polled.summary;
          const usage = await provider.usage(runId);
          if (usage.costUsd !== undefined) lastCost = usage.costUsd;
          if (lastCost !== undefined && lastCost > orch.cost.perRunUsd) {
            killedReason = "the cloud build went over its per-run budget";
            await provider.cancel(runId);
            status = "cancelled";
            break;
          }
        }

        const finishedMs = io.now();
        const cost = lastCost ?? null;
        deps.state.recordStageRun({
          repo: config.repo,
          issue: n,
          stage: "build" as Stage,
          agent: provider.name,
          model,
          started_at: new Date(startedMs).toISOString(),
          finished_at: new Date(finishedMs).toISOString(),
          duration_ms: finishedMs - startedMs,
          tool_calls: 0,
          tokens_in: 0,
          tokens_out: 0,
          cost_usd: cost,
          exit_code: status === "finished" ? 0 : 1,
          killed_reason: killedReason,
          session_id: runId,
          config_hash: configHash(config),
        });

        ledger.settle(n, status);

        if (status !== "finished") {
          const cause = killedReason ?? "the cloud build did not finish successfully";
          return stop(await failStage(deps, config, issue, step.label, "build", cause));
        }

        const pulled = await deps.git.pullBranch(worktree, n);
        if (pulled.code !== 0) {
          return stop(
            await failStage(
              deps,
              config,
              issue,
              step.label,
              "build",
              "the cloud build's branch could not be fast-forwarded",
            ),
          );
        }

        const after = await deps.git.remoteHeadSha(worktree, n);
        if (!after || after === before) {
          return stop(
            await failStage(
              deps,
              config,
              issue,
              step.label,
              "build",
              "the cloud build finished without pushing commits",
            ),
          );
        }

        const gate = await runGates(deps.gateRunner, worktree);
        if (gate.status !== "GREEN") {
          deps.state.updateRun(config.repo, n, { gate_line: gate.raw });
          const cause = stageCause(config, n, "build", CLOUD_OK, { gate });
          return stop(await failStage(deps, config, issue, step.label, "build", cause));
        }

        return finishBuild(sc, gate, {
          status: "done",
          gate_line: gate.raw,
          rounds: 1,
          summary,
        });
      } finally {
        ledger.release(n);
      }
    },
  };
}

async function startCloudRun(
  sc: StepCtx,
  ledger: ReturnType<typeof cloudLedger>,
  provider: CloudProvider,
  model: string,
): Promise<{ before: string; runId: string; summary?: string; status: CloudStatus }> {
  const { deps, config, issue, worktree } = sc;
  const n = issue.number;
  const res = ledger.reservation(n)!;
  const branch = deps.git.branchName(n);
  const prompt = cloudPrompt(issue.body ?? "", branch, config.protectedPaths);
  const sess = ledger.session(n);
  const before = sess?.baseSha ?? (await deps.git.remoteHeadSha(worktree, n)) ?? "";
  const key = `${config.repo}#${n}#${res.attempt}`;
  const launched = await provider.launch({
    repoUrl: `https://github.com/${config.repo}`,
    branch,
    prompt,
    model,
    key,
    title: issue.title,
  });
  ledger.started(n, provider.name, launched.id, before);
  return { before, runId: launched.id, summary: launched.summary, status: launched.status };
}
