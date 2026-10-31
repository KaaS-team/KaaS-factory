// A labelled set of review findings scores the step that decides which findings may block.
// Precision and recall below the pinned floors fail CI.
// A live model judge is not scored here.

import type { Finding } from "./artifacts";
import { DiffAnchorRechecker } from "./recheck";

// A rechecker that always answers; the scored one never returns undefined.
interface Answering {
  supported(findings: readonly Finding[], diff: string): Promise<number[]>;
}

export const PRECISION_FLOOR = 0.9;
export const RECALL_FLOOR = 0.9;

export interface CalibrationCase {
  name: string;
  finding: Finding;
  diff: string;
  real: boolean;
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  wrong: string[];
}

export async function scoreRechecker(
  cases: readonly CalibrationCase[],
  rechecker: Answering = new DiffAnchorRechecker(),
): Promise<Score> {
  const s = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const wrong: string[] = [];
  for (const c of cases) {
    const kept = (await rechecker.supported([c.finding], c.diff)).includes(0);
    if (kept && c.real) s.tp++;
    else if (kept) s.fp++;
    else if (c.real) s.fn++;
    else s.tn++;
    if (kept !== c.real) wrong.push(c.name);
  }
  const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
  return { ...s, precision: ratio(s.tp, s.tp + s.fp), recall: ratio(s.tp, s.tp + s.fn), wrong };
}
