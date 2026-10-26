// The public ledger: what shipped and what it cost, for a page anyone can read. Each entry is built
// field by field from an allow-list, then passed through the plane's operator-detail redaction, so a
// model name, a host, a token count, a prompt or a stack trace has no field to ride in on.

import type { FactoryState, Run, StageRun } from "../src/state";
import { OPERATOR_KEYS, withoutOperatorDetail } from "./plane/operator-detail";

export interface ShippedEntry {
  readonly title: string;
  readonly repo: string;
  // The day the PR merged, UTC, with no time: a public page needs no more.
  readonly mergedOn: string;
  readonly cycleHours: number;
  // Whole dollars across every stage attempt; null when any attempt's cost was not fully counted.
  readonly dollars: number | null;
}

export interface PublicLedger {
  readonly generatedOn: string;
  readonly shipped: readonly ShippedEntry[];
}

export const ENTRY_KEYS: readonly (keyof ShippedEntry)[] = ["title", "repo", "mergedOn", "cycleHours", "dollars"];

// Text a title may carry that is operator detail: model names, hosts and addresses, token counts and
// stack frames. Issue titles are written by people, who do name the model they want swapped.
export const FORBIDDEN_TEXT: readonly RegExp[] = [
  /\b(claude|anthropic|openai|gpt|chatgpt|gemini|llama|mistral|mixtral|qwen|deepseek|nemotron|haiku|sonnet|opus|codex|grok|kimi|openrouter|ollama)\b[\w.:/-]*/gi,
  /\bo\d(-mini|-pro)?\b/gi,
  /\b[\w-]+(\.[\w-]+)*\.(local|internal|lan|localdomain)\b/gi,
  /\blocalhost(:\d+)?\b/gi,
  /\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g,
  /\b\d[\d,.]*\s*k?\s*tokens?\b/gi,
  /\bat\s+\S+\s+\(?\S+:\d+:\d+\)?/g,
  /\b\w*Error:\s.*$/g,
];

export function scrubText(text: string): string {
  let out = text;
  for (const re of FORBIDDEN_TEXT) out = out.replace(re, "[redacted]");
  return out.replace(/\s+/g, " ").trim();
}

// Every leak in a ledger: a key outside the allow-list or among the plane's operator keys, and any
// string that still matches FORBIDDEN_TEXT. The export refuses to write a ledger with one.
export function publicLeaks(ledger: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string) => {
    if (typeof v === "string") {
      for (const re of FORBIDDEN_TEXT) {
        re.lastIndex = 0;
        if (re.test(v)) out.push(`${at}: ${JSON.stringify(v)}`);
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (OPERATOR_KEYS.has(k)) out.push(`${at}.${k}: an operator key`);
        walk(x, `${at}.${k}`);
      }
  };
  const doc = ledger as Partial<PublicLedger>;
  for (const k of Object.keys(doc ?? {}))
    if (k !== "generatedOn" && k !== "shipped") out.push(`${k}: not a ledger field`);
  (doc?.shipped ?? []).forEach((e, i) => {
    for (const k of Object.keys(e))
      if (!(ENTRY_KEYS as string[]).includes(k)) out.push(`shipped[${i}].${k}: not public`);
  });
  walk(ledger, "ledger");
  return out;
}

export interface Merge {
  readonly repo: string;
  readonly issue: number;
  readonly at: string;
}

// The first factory.pr.merged event per issue, oldest first: a PR the factory only opened is not
// shipped, and the PR poll and an operator's merge both emit one for the same issue.
export function mergesIn(state: Pick<FactoryState, "busEvents">): Merge[] {
  const out = new Map<string, Merge>();
  let after = 0;
  for (;;) {
    const page = state.busEvents(500, after);
    if (!page.length) return [...out.values()];
    for (const e of page) {
      if (e.type !== "factory.pr.merged") continue;
      const d = JSON.parse(e.data) as { repo?: unknown; issue?: unknown };
      const key = `${d.repo}#${d.issue}`;
      if (typeof d.repo === "string" && typeof d.issue === "number" && !out.has(key))
        out.set(key, { repo: d.repo, issue: d.issue, at: e.time });
    }
    after = page.at(-1)!.seq ?? after + page.length;
  }
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

function dollars(attempts: readonly StageRun[]): number | null {
  if (attempts.some((a) => a.cost_usd === null || !a.usage_complete)) return null;
  return Math.round(attempts.reduce((n, a) => n + (a.cost_usd ?? 0), 0));
}

export function shippedEntry(merge: Merge, run: Run | undefined, attempts: readonly StageRun[]): ShippedEntry {
  const started = run ? Date.parse(run.started_at) : Number.NaN;
  const hours = (Date.parse(merge.at) - started) / 3_600_000;
  return {
    title: scrubText(run?.title ?? `Issue ${merge.issue}`) || `Issue ${merge.issue}`,
    repo: merge.repo,
    mergedOn: day(merge.at),
    cycleHours: Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 10) / 10 : 0,
    dollars: dollars(attempts),
  };
}

// Newest first, one entry per merged PR.
export function publicLedger(states: readonly FactoryState[], now = new Date()): PublicLedger {
  const shipped = states.flatMap((state) =>
    mergesIn(state).map((m) =>
      shippedEntry(m, state.getRun(m.repo, m.issue), state.listStageRuns(m.repo, { issue: m.issue, limit: 10_000 })),
    ),
  );
  shipped.sort((a, b) => b.mergedOn.localeCompare(a.mergedOn));
  return withoutOperatorDetail({ generatedOn: day(now.toISOString()), shipped }) as PublicLedger;
}
