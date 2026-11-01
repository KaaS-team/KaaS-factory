// policy.review.independent: when the policy asks for it, the judge never shares the builder's session.
// "manual" asks for nothing, "always" asks on every run, "when-sensitive" asks on a high-risk plan or a
// diff that touches a path a human always reviews. Pure: it reads session ids it is handed and runs nothing.

import { humanPathRefusals } from "./human-paths";

export const INDEPENDENT_POLICIES = ["manual", "when-sensitive", "always"] as const;
export type IndependentPolicy = (typeof INDEPENDENT_POLICIES)[number];

export interface RunSession {
  readonly stage: string;
  readonly session_id: string | null;
}

export interface Sensitivity {
  readonly risk?: string;
  readonly files: readonly { readonly path: string }[];
  readonly extraHumanPaths?: readonly string[];
}

// Reads `policy.review.independent` from a parsed config. Absent means "manual"; anything else that
// is not one of the three names is a problem, never a silent fallback to a weaker policy.
export function parseIndependentPolicy(raw: unknown): { policy: IndependentPolicy; problems: string[] } {
  const value = (raw as { policy?: { review?: { independent?: unknown } } } | null | undefined)?.policy?.review
    ?.independent;
  if (value === undefined) return { policy: "manual", problems: [] };
  const known = INDEPENDENT_POLICIES.find((p) => p === value);
  if (known) return { policy: known, problems: [] };
  return {
    policy: "always",
    problems: [`policy.review.independent: ${JSON.stringify(value)} is not one of ${INDEPENDENT_POLICIES.join(", ")}`],
  };
}

export function isSensitive(s: Sensitivity): boolean {
  return s.risk === "high" || humanPathRefusals(s.files, s.extraHumanPaths).length > 0;
}

export function independenceRequired(policy: IndependentPolicy, sensitive: boolean): boolean {
  return policy === "always" || (policy === "when-sensitive" && sensitive);
}

// A verify run that carries a build run's session id is the builder grading its own work.
export function sharedSessions(runs: readonly RunSession[]): string[] {
  const built = new Set(runs.filter((r) => r.stage === "build" && r.session_id).map((r) => r.session_id));
  const shared = runs.filter((r) => r.stage === "verify" && r.session_id && built.has(r.session_id));
  return [...new Set(shared.map((r) => r.session_id as string))];
}

export interface IndependenceVerdict {
  readonly required: boolean;
  readonly ok: boolean;
  readonly reason?: string;
}

export function checkIndependence(
  policy: IndependentPolicy,
  sensitivity: Sensitivity,
  runs: readonly RunSession[],
): IndependenceVerdict {
  const required = independenceRequired(policy, isSensitive(sensitivity));
  const shared = required ? sharedSessions(runs) : [];
  return shared.length
    ? { required, ok: false, reason: `the verify stage shares the builder's session (${shared.join(", ")})` }
    : { required, ok: true };
}
