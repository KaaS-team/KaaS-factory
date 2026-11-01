// The `qa` step kind: renders what a running app showed as a PR body section. The render is pure;
// the runner that starts the app is injected, so tests never start one. Off unless FACTORY_QA=1.
import type { StepResult, StepType } from "./engine/steps";

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
export async function runQaStep(
  input: Omit<QaInput, "results">,
  runner: QaRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly ran: boolean; readonly section?: string; readonly ok: boolean }> {
  if (!qaEnabled(env)) return { ran: false, ok: true };
  const results = await runner(input.run, input.routes);
  return {
    ran: true,
    section: renderQa({ ...input, results }),
    ok: input.routes.every((p) => results.some((r) => r.path === p && r.ok)),
  };
}

// The registered kind. Only the not-enabled path is wired: with FACTORY_QA=1 it parks until a real
// runner is wired in, because starting an app is not part of this slice.
export const qaStep: StepType = {
  command: true,
  async run(): Promise<StepResult> {
    if (!qaEnabled()) return { kind: "next", facts: { ok: true, skipped: true } };
    throw new Error("the qa step has no app runner wired yet; use a check step running .factory/qa.sh");
  },
};
