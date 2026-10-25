// Per-model list prices in USD per million tokens. An unknown model is
// undefined, never 0: an invented price is worse than "Not reported".
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly source: string;
  readonly asOf: string;
}

const ANTHROPIC = "https://www.anthropic.com/pricing";

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, source: ANTHROPIC, asOf: "2026-09-24" },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    source: ANTHROPIC,
    asOf: "2026-09-24",
  },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, source: ANTHROPIC, asOf: "2026-09-24" },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, source: ANTHROPIC, asOf: "2026-09-27" },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, source: ANTHROPIC, asOf: "2026-09-27" },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, source: ANTHROPIC, asOf: "2026-10-08" },
  "claude-fable-5-1": {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
    source: ANTHROPIC,
    asOf: "2026-10-08",
  },
};

// Models the docs and example config name whose price has not been sourced yet.
// Each one shows "Not reported" until a row moves into PRICES.
export const UNPRICED: Readonly<Record<string, string>> = {
  "claude-haiku-5-5": "tiered by prompt size (100K tokens); Price has one rate, so it stays unpriced",
  "gpt-5.6-terra": "OpenAI list price not yet captured (needs a source URL)",
};

export interface PricedUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  // Cache reads, already counted inside tokensIn (Claude adds them there).
  readonly tokensCached?: number;
}

// Dated snapshots ("claude-haiku-4-5-20251001") price as their family.
function lookup(model: string): Price | undefined {
  const key = model.replace(/-\d{8}$/, "");
  return PRICES[key];
}

export function costFor(model: string | null | undefined, usage: PricedUsage): number | undefined {
  if (!model) return undefined;
  const p = lookup(model);
  if (!p) return undefined;
  const cached = Math.min(usage.tokensCached ?? 0, usage.tokensIn);
  return ((usage.tokensIn - cached) * p.input + cached * p.cacheRead + usage.tokensOut * p.output) / 1e6;
}
