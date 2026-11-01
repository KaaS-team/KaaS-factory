// The factory's own runs as sessions (mission control): read-only over state.db, steering through
// the existing applySteer path. A stage that started a cloud session adds a child row for it.

import { applySteer, type SteerTracker } from "../../integrations/steer";
import {
  type AgentSession,
  type SessionAdapter,
  type SessionEvent,
  type SessionRef,
  SessionUnsupported,
} from "../../ports/session";
import type { FactoryState, Run, StageRun } from "../../state";
import { fromRunStatus } from "../schema";

export interface FactoryAdapterDeps {
  state: Pick<FactoryState, "listRuns" | "getRun" | "listEvents" | "listStageRuns">;
  repos: () => string[];
  tracker: SteerTracker;
  actor: string;
  dashboardUrl?: string;
}

const KIND = "factory";
// Stage harness name to the runtime kind of the adapter that owns its cloud sessions.
const CLOUD: Readonly<Record<string, string>> = { claude: "claude-code", cursor: "cursor", codex: "codex" };
const POLL_MS = 2000;

const ref = (repo: string, issue: number): SessionRef => ({
  runtime: KIND,
  connection: KIND,
  externalId: `${repo}#${issue}`,
});

function parse(r: SessionRef): { repo: string; issue: number } | undefined {
  const m = /^(.+)#(\d+)$/.exec(r.externalId);
  return m ? { repo: m[1]!, issue: Number(m[2]) } : undefined;
}

export function factoryAdapter(deps: FactoryAdapterDeps): SessionAdapter {
  const base = deps.dashboardUrl?.startsWith("https:") ? deps.dashboardUrl.replace(/\/+$/, "") : undefined;
  const linkOf = (run: Run) => run.pr_url ?? (base ? `${base}/runs/${run.id}` : undefined);

  const toSession = (run: Run, stages: StageRun[]): AgentSession => {
    const unknown = stages.some((s) => s.cost_usd === null);
    const total = stages.reduce((sum, s) => sum + (s.cost_usd ?? 0), 0);
    const state = fromRunStatus(run.status);
    const last = stages.at(-1);
    return {
      ref: ref(run.repo, run.issue),
      title: run.title.slice(0, 200),
      state,
      repo: run.repo,
      issue: run.issue,
      stage: run.stage,
      startedAt: run.started_at,
      updatedAt: run.updated_at,
      ...(linkOf(run) ? { link: linkOf(run) } : {}),
      ...(run.pr_url ? { prUrl: run.pr_url } : {}),
      ...(state === "waiting" && run.reason ? { needsYou: run.reason.slice(0, 200) } : {}),
      costUsd: unknown ? null : total,
      tokensIn: run.tokens_in,
      tokensOut: run.tokens_out,
      ...(last?.model ? { model: last.model } : {}),
      configHash: run.config_hash,
    };
  };

  const children = (run: Run, stages: StageRun[]): AgentSession[] =>
    stages.flatMap((s) => {
      const runtime = CLOUD[s.agent];
      if (!runtime || !s.session_id) return [];
      return [
        {
          ref: { runtime, connection: KIND, externalId: s.session_id },
          title: `${run.title} (${s.stage})`.slice(0, 200),
          state: fromRunStatus(run.status),
          repo: run.repo,
          issue: run.issue,
          stage: s.stage,
          startedAt: s.started_at,
          updatedAt: s.finished_at,
        },
      ];
    });

  const stagesOf = (run: Run) => deps.state.listStageRuns(run.repo, { issue: run.issue, limit: 1000 });

  const runOf = (r: SessionRef): Run | undefined => {
    const p = parse(r);
    return p ? deps.state.getRun(p.repo, p.issue) : undefined;
  };

  const adapter: SessionAdapter = {
    kind: KIND,
    caps: { list: true, events: "poll", cancel: true, followUp: true, deepLink: true },
    async list() {
      const out: AgentSession[] = [];
      for (const repo of deps.repos()) {
        for (const run of deps.state.listRuns(repo)) {
          const stages = stagesOf(run);
          out.push(toSession(run, stages), ...children(run, stages));
        }
      }
      return out;
    },
    async get(r) {
      const run = runOf(r);
      return run ? toSession(run, stagesOf(run)) : undefined;
    },
    async follow(r, after, onEvent, signal) {
      let cursor = after === undefined ? 0 : Number(after) || 0;
      let lastStage: string | undefined;
      while (!signal?.aborted) {
        const run = runOf(r);
        if (run) {
          for (const row of deps.state.listEvents(run.id, { after: cursor })) {
            const e: SessionEvent = { ref: r, at: row.ts, kind: "note", text: row.text.slice(0, 280) };
            if (row.stage !== lastStage && lastStage !== undefined) {
              e.kind = "stage";
              e.stage = row.stage;
            } else if (row.kind === "status" || row.kind === "state") {
              e.kind = "state";
              e.state = fromRunStatus(run.status);
            }
            lastStage = row.stage;
            cursor = row.id;
            onEvent(e);
          }
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, POLL_MS);
          function done() {
            clearTimeout(t);
            signal?.removeEventListener("abort", done);
            resolve();
          }
          signal?.addEventListener("abort", done, { once: true });
        });
      }
      return cursor === 0 ? after : String(cursor);
    },
    link(r) {
      const run = runOf(r);
      return run ? linkOf(run) : undefined;
    },
    async cancel(r) {
      const p = parse(r);
      if (!p) throw new SessionUnsupported(`${r.externalId} is not a factory run`);
      await applySteer(deps.tracker, p.repo, { kind: "act", issue: p.issue, action: "cancel", text: "" }, deps.actor);
    },
    async followUp(r, text) {
      const p = parse(r);
      const run = runOf(r);
      if (!p || !run || (run.status !== "needs-info" && run.status !== "awaiting-approval"))
        throw new SessionUnsupported("this run is not waiting for anyone");
      const action = run.status === "awaiting-approval" ? "revise" : "answer";
      await applySteer(deps.tracker, p.repo, { kind: "act", issue: p.issue, action, text }, deps.actor);
    },
  };
  return adapter;
}
