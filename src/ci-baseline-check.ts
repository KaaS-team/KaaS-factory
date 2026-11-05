// A KaaS-team repo must call the shared CI baseline workflow (#349), and the call must not be
// skipped or allowed to fail. Pure over the workflow files; doctor-checks.ts reads them from disk.
import type { DoctorCheck } from "./doctor";

export const BASELINE_USES = /^kaas-team\/kaas-factory\/\.github\/workflows\/ci-baseline\.yml@\S+$/i;
export interface WorkflowFile {
  readonly path: string;
  readonly content: string;
}

const row = (name: string, ok: boolean, detail: string): DoctorCheck => ({
  name: `ci baseline: ${name}`,
  ok,
  detail,
  fixable: false,
});

type Job = { uses?: unknown; "continue-on-error"?: unknown; if?: unknown };

export function ciBaselineChecks(repo: string, workflows: readonly WorkflowFile[]): DoctorCheck[] {
  if (!/^kaas-team\//i.test(repo)) return [];
  const parsed = workflows.map((w) => {
    try {
      return { path: w.path, doc: Bun.YAML.parse(w.content) as { on?: unknown; jobs?: Record<string, Job> } | null };
    } catch {
      return { path: w.path, doc: null };
    }
  });
  // The repo that owns the reusable workflow defines it instead of calling it.
  if (
    parsed.some(
      (p) => /(^|\/)ci-baseline\.ya?ml$/.test(p.path) && JSON.stringify(p.doc?.on ?? "").includes("workflow_call"),
    )
  )
    return [row("defined here", true, "this repo owns the reusable baseline workflow")];
  const calls = parsed.flatMap((p) =>
    Object.entries(p.doc?.jobs ?? {})
      .filter(([, job]) => typeof job?.uses === "string" && BASELINE_USES.test(job.uses))
      .map(([id, job]) => ({ where: `${p.path} job "${id}"`, job })),
  );
  if (calls.length === 0)
    return [
      row(
        "called",
        false,
        "no workflow calls KaaS-team/KaaS-factory/.github/workflows/ci-baseline.yml@<ref>; add a job with `uses:` pointing at it",
      ),
    ];
  const drift = calls.flatMap(({ where, job }) => [
    ...(job["continue-on-error"] === true ? [`${where} sets continue-on-error, so the baseline cannot fail`] : []),
    ...(job.if !== undefined ? [`${where} has an if:, so the baseline can be skipped`] : []),
  ]);
  return [row("not drifted", drift.length === 0, drift.length ? drift.join("; ") : "called on every run")];
}
