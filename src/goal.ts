// The build prompt opens with a goal checklist and deviation checkpoints, and verify refuses a build report
// that leaves a row unchecked or a checkpoint unanswered (#636). One list of checkpoints serves both.

export const CHECKPOINTS = [
  "Plan: every changed file is in the plan's files.",
  "Scope: the diff serves only the acceptance lines.",
  "Meaning: no acceptance line was reworded or weakened.",
  "Proof: you saw each new test fail before the fix.",
  "Pins: no cap or pinned count was raised to pass.",
  "Neighbours: tests that import a changed file pass.",
] as const;

export interface Row {
  readonly id: string;
  readonly text: string;
}

// The lines under an Acceptance heading, plus any `AC-n:` line, in the order written.
export function acceptanceLines(body: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      inSection = /^#{1,6}\s*acceptance\b/i.test(line);
      continue;
    }
    const item = /^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)?.[1];
    if (/^\W*AC-\d+\W/i.test(line.replace(/^(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""))) out.push(item ?? line);
    else if (inSection && item) out.push(item);
  }
  return out;
}

// The plan's AC rows. The build prompt carries a goal only when there are some, and verify holds the report
// to a goal only then.
export function rowsFrom(plan: { readonly criteria?: readonly Row[] } | undefined): Row[] {
  return (plan?.criteria ?? []).map((c) => ({ id: c.id, text: c.text }));
}

export const NO_ACCEPTANCE_LINE =
  "This issue has no acceptance lines; add an Acceptance section with one line per check and press retry.";

export function goalSection(rows: readonly Row[]): string {
  const goal = rows.map((r) => `- [ ] ${r.id}: ${r.text} -> test: <name>`).join("\n");
  const checks = CHECKPOINTS.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    "Goal: done when every row is checked, each with the test that proves it. Report them in build.json `goal` as {id, test, checked}.",
    goal,
    "Checkpoints, answered before every commit in build.json `checkpoints` as {id, answer}. A no is a deviation: undo it or stop blocked.",
    checks,
  ]
    .filter(Boolean)
    .join("\n");
}

interface Report {
  readonly goal?: unknown;
  readonly checkpoints?: unknown;
}

const rowsOf = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null) : [];

// Why a build report cannot be verified, or an empty list. `ids` are the plan's AC ids when it has any.
export function reportProblems(build: Report, ids: readonly string[]): string[] {
  const out: string[] = [];
  const goal = rowsOf(build.goal);
  if (goal.length === 0) out.push("build.json has no goal rows");
  for (const id of ids) if (!goal.some((r) => r.id === id)) out.push(`goal row ${id} is missing`);
  for (const r of goal) {
    if (r.checked !== true) out.push(`goal row ${String(r.id)} is unchecked`);
    else if (typeof r.test !== "string" || r.test.trim() === "") out.push(`goal row ${String(r.id)} names no test`);
  }
  const answers = rowsOf(build.checkpoints);
  CHECKPOINTS.forEach((text, i) => {
    const a = answers.find((r) => r.id === i + 1)?.answer;
    if (typeof a !== "string" || a.trim() === "") out.push(`checkpoint ${i + 1} is unanswered (${text.split(":")[0]})`);
    else if (!/^yes\b/i.test(a.trim())) out.push(`checkpoint ${i + 1} is a deviation: ${a.trim()}`);
  });
  return out;
}
