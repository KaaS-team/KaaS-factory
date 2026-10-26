// The spec stage: one agent turns a one-line intent into a spec in check-acceptance.py's format, a
// markdown file under specs/ with one "AC-n: text" line per criterion and holdouts at
// holdout/<stem>/AC-n.*. The agent drafts it; specProblems below decides whether it is one.

import type { Executor, StageRunResult } from "../ports/agent";
import { minionOutput } from "../engine/minion";

// The kit's scripts/kaas/check-acceptance.py AC_LINE, so a criterion this finds is one that script holds.
export const AC_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(AC-\d+)(?:\*\*)?\s*[:.]\s*(.+?)\s*$/gm;
const SLUG = /^\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Criterion {
  readonly id: string;
  readonly text: string;
}

export interface Spec {
  // The file stem, so holdouts for it live at holdout/<slug>/AC-n.*.
  readonly slug: string;
  readonly markdown: string;
}

export function criteria(markdown: string): Criterion[] {
  return [...markdown.matchAll(AC_LINE)].map((m) => ({ id: m[1]!, text: m[2]! }));
}

// Every way a draft is not a spec. Criteria are AC-1, AC-2, ... in order, each once, so a ticket
// that names AC-3 names exactly one promise and none is skipped.
export function specProblems(spec: Spec): string[] {
  const problems: string[] = [];
  if (!SLUG.test(spec.slug)) problems.push(`slug "${spec.slug}" is not NN-words-with-dashes`);
  const acs = criteria(spec.markdown);
  if (acs.length === 0) problems.push("the spec has no acceptance criteria (AC-1: ...)");
  const seen = new Set<string>();
  acs.forEach((ac, i) => {
    if (seen.has(ac.id)) problems.push(`${ac.id} is defined twice`);
    else if (ac.id !== `AC-${i + 1}`) problems.push(`${ac.id} is out of order: expected AC-${i + 1}`);
    seen.add(ac.id);
  });
  return problems;
}

export function specPath(spec: Spec): string {
  return `specs/${spec.slug}.md`;
}

export interface StageAgent {
  readonly executor: Executor;
  // The config.agents name this stage runs as; the two stages must name different agents.
  readonly agent: string;
  readonly cwd: string;
  readonly maxBudgetUsd: number;
  readonly timeoutMinutes?: number;
}

export type StageOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly run: StageRunResult }
  | { readonly ok: false; readonly problems: readonly string[]; readonly run?: StageRunResult };

// The intent is someone else's words, so it goes in as data, never as instructions.
export function specPrompt(intent: string): string {
  return [
    "Write a product spec for the intent below.",
    'Answer with one JSON object and nothing else: {"slug": "NN-short-name", "markdown": "..."}.',
    "The markdown has a title, a short problem statement, and one line per acceptance criterion,",
    "numbered from one: `AC-1: <one observable, testable promise>`, `AC-2: ...`. Each criterion must be",
    "something a holdout test can check without reading the code.",
    "<intent>",
    intent.replace(/</g, "&lt;"),
    "</intent>",
  ].join("\n");
}

export function readSpec(raw: unknown): Spec | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { slug, markdown } = raw as Record<string, unknown>;
  return typeof slug === "string" && typeof markdown === "string" ? { slug, markdown } : undefined;
}

// Runs as a read-only plan stage with no issue: the agent may read the repo and answers in its message.
export async function runSpecStage(stage: StageAgent, intent: string): Promise<StageOutcome<Spec>> {
  if (!intent.trim()) return { ok: false, problems: ["the intent is empty"] };
  const run = await stage.executor.runStage({
    stage: "plan",
    issue: 0,
    cwd: stage.cwd,
    agent: stage.agent,
    prompt: specPrompt(intent),
    maxBudgetUsd: stage.maxBudgetUsd,
    timeoutMinutes: stage.timeoutMinutes,
  });
  if (run.exitCode !== 0) return { ok: false, problems: [`the spec agent exited ${run.exitCode}`], run };
  const spec = readSpec(minionOutput("", run.finalMessage));
  if (!spec) return { ok: false, problems: ['the spec agent did not answer {"slug", "markdown"}'], run };
  const problems = specProblems(spec);
  return problems.length ? { ok: false, problems, run } : { ok: true, value: spec, run };
}
