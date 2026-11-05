// Triage states how sure it is (0 to 1). Below the threshold the issue is parked for a human with
// the open questions listed, instead of reaching plan and build.

export const DEFAULT_TRIAGE_MIN_CONFIDENCE = 0.5;
export const TRIAGE_MIN_CONFIDENCE_ENV = "FACTORY_TRIAGE_MIN_CONFIDENCE";

// The configured threshold: the env value when it is a number from 0 to 1, else the default.
export function triageMinConfidence(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TRIAGE_MIN_CONFIDENCE_ENV]?.trim();
  if (!raw) return DEFAULT_TRIAGE_MIN_CONFIDENCE;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_TRIAGE_MIN_CONFIDENCE;
}

import { finish, moveLabel, postComment } from "./engine/common";
import { LABEL } from "./labels";
import type { StepCtx } from "./engine/steps";
import type { StepResult } from "./engine/steps";

export interface TriageParking {
  readonly reason: string;
  readonly comment: string;
}

// undefined means dispatch goes on: confidence missing, not a number, or at or above the threshold.
export function triageParking(
  json: { readonly confidence?: unknown; readonly confidence_reasons?: readonly string[]; readonly done_when?: string },
  questions: string | undefined,
  threshold: number,
): TriageParking | undefined {
  const c = json.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c >= threshold) return undefined;
  const reason = `triage confidence ${c} is below the threshold ${threshold}`;
  const asked = questions?.trim();
  const why = (json.confidence_reasons ?? []).map((r) => r.trim()).filter(Boolean);
  const lines = [
    `Triage is not confident enough to start a build (${c} against a threshold of ${threshold}), so this issue is parked for a human.`,
    ...(why.length ? ["", `Why: ${why.join("; ")}`] : []),
    "",
    asked
      ? `Open questions:\n\n${asked}`
      : "Open questions: none were listed. Please say what is unclear or missing in the issue.",
    "",
    "Edit the issue and relabel it to run again.",
  ];
  return { reason, comment: lines.join("\n") };
}

// The triage step's call: parks a low-confidence proceed for a human, or returns undefined to go on.
export async function parkLowConfidence(
  sc: StepCtx,
  json: { readonly confidence?: unknown; readonly confidence_reasons?: readonly string[]; readonly done_when?: string },
  questions: string | undefined,
): Promise<StepResult | undefined> {
  const { deps, config, issue, step } = sc;
  const parked = triageParking(json, questions, triageMinConfidence(process.env));
  if (!parked) return undefined;
  await postComment(deps, config, issue.number, parked.comment, { stage: "question", json: { stage: step.id } });
  await moveLabel(deps, config, issue.number, step.label, LABEL.needsHuman);
  finish(deps, config, issue.number, "needs-human", parked.reason);
  return { kind: "stop", outcome: "needs-human" };
}
