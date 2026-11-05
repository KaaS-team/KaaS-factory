// Keyed scored checks: each row holds a check's key, score, max, previous score and last 10 scores.
// recordScore appends to a history file; readChecks is what the merge step reads (mergeContext), and
// scoredRefusals turns a required check's missing or low row into a merge refusal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const HISTORY_LIMIT = 10;

export interface CheckRow {
  readonly key: string;
  readonly score: number;
  readonly max: number;
  readonly previous: number | undefined;
  readonly last: readonly number[];
}

type History = Record<string, { max: number; scores: number[] }>;

function load(file: string): History {
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as History) : {};
  } catch {
    return {};
  }
}

function row(key: string, h: { max: number; scores: number[] }): CheckRow {
  const last = h.scores.slice(-HISTORY_LIMIT);
  return {
    key,
    score: last[last.length - 1] as number,
    max: h.max,
    previous: last.length > 1 ? last[last.length - 2] : undefined,
    last,
  };
}

export function recordScore(file: string, key: string, score: number, max: number): CheckRow {
  if (!key || !Number.isFinite(score) || !Number.isFinite(max) || max <= 0 || score < 0 || score > max) {
    throw new Error(`bad scored check ${JSON.stringify(key)}: ${score} of ${max}`);
  }
  const history = load(file);
  const scores = [...(history[key]?.scores ?? []), score].slice(-HISTORY_LIMIT);
  history[key] = { max, scores };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(history, null, 2)}\n`);
  return row(key, history[key]);
}

export function readChecks(file: string): readonly CheckRow[] {
  return Object.entries(load(file))
    .filter(([, h]) => Array.isArray(h.scores) && h.scores.length > 0)
    .map(([key, h]) => row(key, h));
}

export const SCORES_FILE = ".factory/scores.json";

// A required check: its key and the lowest score that lets a merge through.
export type RequiredChecks = Readonly<Record<string, number>>;

export interface ScoredFacts {
  readonly required: RequiredChecks;
  readonly rows: readonly CheckRow[];
}

// One reason per required check that has no row or scores under its threshold.
export function scoredRefusals(facts: ScoredFacts): string[] {
  const out: string[] = [];
  for (const [key, min] of Object.entries(facts.required)) {
    const r = facts.rows.find((x) => x.key === key);
    if (!r) out.push(`required check "${key}" has no score`);
    else if (r.score < min) out.push(`check "${key}" scored ${r.score} of ${r.max}, under its threshold ${min}`);
  }
  return out;
}
