// The `qa` step kind: renders what a running app showed as a PR body section. The render is pure;
// the runner that starts the app is injected, so tests never start one. Off unless FACTORY_QA=1.
import { finish, moveLabel, postComment } from "./engine/common";
import type { StepCtx, StepResult, StepType } from "./engine/steps";
import { LABEL } from "./labels";
import { readQa } from "./qa";
import { ShellSetupRunner } from "./setup";

export interface QaCriterion {
  readonly id: string;
  readonly text: string;
  // The plan routes this criterion is exercised on.
  readonly routes: readonly string[];
}
export interface QaRouteResult {
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
}
export interface QaInput {
  readonly routes: readonly string[];
  readonly run: string;
  readonly results: readonly QaRouteResult[];
  readonly criteria?: readonly QaCriterion[];
}

// pass: every route of the criterion was visited and ok. fail: one failed or was not visited.
// not exercised: the criterion names no route.
export function criterionVerdict(c: QaCriterion, results: readonly QaRouteResult[]): "pass" | "fail" | "not exercised" {
  if (c.routes.length === 0) return "not exercised";
  return c.routes.every((p) => results.some((r) => r.path === p && r.ok)) ? "pass" : "fail";
}

export function renderQa(input: QaInput): string {
  const visited = new Map(input.results.map((r) => [r.path, r]));
  const rows = input.routes.map((p) => {
    const r = visited.get(p);
    return r ? `| \`${p}\` | ${r.status} | ${r.ok ? "pass" : "fail"} |` : `| \`${p}\` | none | fail |`;
  });
  const out = [
    "## QA",
    "",
    `App started with \`${input.run}\`.`,
    "",
    "| Route | Status | Result |",
    "| --- | --- | --- |",
    ...rows,
  ];
  if (input.criteria?.length) {
    out.push("", "| Acceptance criterion | Result |", "| --- | --- |");
    for (const c of input.criteria) out.push(`| ${c.id}: ${c.text} | ${criterionVerdict(c, input.results)} |`);
  }
  return out.join("\n");
}

export type QaRunner = (run: string, routes: readonly string[]) => Promise<readonly QaRouteResult[]>;

export const qaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FACTORY_QA === "1";

// Not enabled: the step is skipped and the workflow goes on. Enabled: the runner drives the app.
// No routes named: the routes the runner visited are the ones judged, and none visited is not ok.
export async function runQaStep(
  input: Omit<QaInput, "results">,
  runner: QaRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly ran: boolean; readonly section?: string; readonly ok: boolean }> {
  if (!qaEnabled(env)) return { ran: false, ok: true };
  const results = await runner(input.run, input.routes);
  const routes = input.routes.length ? input.routes : results.map((r) => r.path);
  return {
    ran: true,
    section: renderQa({ ...input, routes, results }),
    ok: routes.length > 0 && routes.every((p) => results.some((r) => r.path === p && r.ok)),
  };
}

// The registered kind. The step's `run:` command starts the app and writes qa.json (template
// .factory/qa.sh); the routes in it are judged by runQaStep and the table is posted as a stage comment.
// Not enabled: skipped. A runner that throws or a failed route parks the issue failed, never a crash.
export const qaStep: StepType = {
  command: true,
  async run(sc: StepCtx): Promise<StepResult> {
    if (!qaEnabled()) return { kind: "next", facts: { ok: true, skipped: true } };
    const { deps, config, issue, worktree, step } = sc;
    const name = step.runtime ?? config.runtime?.check;
    const runtime = name ? deps.runtimes?.[name] : (deps.setupRunner ?? new ShellSetupRunner());
    let outcome: Awaited<ReturnType<typeof runQaStep>>;
    let error: string | undefined;
    try {
      if (!runtime) throw new Error(`no runtime "${name}" on this machine`);
      outcome = await runQaStep({ routes: [], run: step.run! }, async (run) => {
        const out = await runtime.run(run, worktree);
        if (out.code !== 0) throw new Error(`\`${run}\` exited ${out.code}`);
        return readQa(worktree, issue.number)?.routes ?? [];
      });
    } catch (e) {
      outcome = { ran: true, ok: false };
      error = e instanceof Error ? e.message : String(e);
    }
    if (outcome.ok) {
      await postComment(deps, config, issue.number, outcome.section ?? "", { stage: step.id, json: { ok: true } });
      return { kind: "next", facts: { ok: true } };
    }
    const body = outcome.section ?? `Step \`${step.id}\` failed: ${error ?? "no route was visited"}.`;
    await postComment(deps, config, issue.number, body, { stage: step.id, json: { ok: false } });
    await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
    finish(deps, config, issue.number, "failed", `${step.id}: ${error ?? "a route failed"}`);
    return { kind: "stop", outcome: "failed" };
  },
};
