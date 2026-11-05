// Backlog ranking for pickup. `prioritize.method` in .factory/config.json picks the formula; scores are
// "Reach: 3" style lines in the issue body, and unscored issues rank after every scored one.

import type { GhIssue } from "./github";

export type PriorityMethod = "rice" | "wsjf";

const INPUTS: Record<PriorityMethod, readonly string[]> = {
  rice: ["reach", "impact", "confidence", "effort"],
  wsjf: ["value", "urgency", "risk", "size"],
};

// "Reach: 3" lines in the body. RICE is reach*impact*confidence/effort; WSJF is (value+urgency+risk)/size.
export function scoreOf(body: string, method: PriorityMethod): number | undefined {
  const v: number[] = [];
  for (const key of INPUTS[method]) {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*$`, "im").exec(body);
    if (!m) return undefined;
    v.push(Number(m[1]));
  }
  const [a, b, c, d] = v as [number, number, number, number];
  if (method === "rice") return d > 0 ? (a * b * c) / d : undefined;
  return c !== undefined && d > 0 ? (a + b + c) / d : undefined;
}

// Highest score first; an unscored issue goes after every scored one, oldest first. No method: oldest first.
export function rankIssues<T extends Pick<GhIssue, "number" | "body">>(
  issues: readonly T[],
  method: PriorityMethod | undefined,
): T[] {
  const score = (i: T) => (method ? scoreOf(i.body, method) : undefined);
  return [...issues].sort((x, y) => {
    const a = score(x);
    const b = score(y);
    if (a !== undefined && b !== undefined && a !== b) return b - a;
    if ((a === undefined) !== (b === undefined)) return a === undefined ? 1 : -1;
    return x.number - y.number;
  });
}

export const byRank =
  (method: PriorityMethod | undefined) =>
  (x: Pick<GhIssue, "number" | "body">, y: Pick<GhIssue, "number" | "body">): number =>
    rankIssues([x, y], method)[0] === x ? -1 : 1;

export function prioritizeProblems(raw: unknown): string[] {
  const m = (raw as Record<string, unknown>).method;
  return m === "rice" || m === "wsjf" ? [] : [`prioritize.method: expected "rice" or "wsjf", got ${JSON.stringify(m)}`];
}
