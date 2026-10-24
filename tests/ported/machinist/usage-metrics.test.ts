// Ported from owainlewis/machinist@3943516 evals/test_agent.py:1113-1146 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: record_usage accumulates into a global METRICS dict; readUsage returns one event's usage and the test sums them; there is no cache_write field, so only reads are asserted.

import { expect, test } from "bun:test";
import { readUsage } from "../../../src/agents/usage";
import { costFor } from "../../../src/pricing";

test("unknown usage is not zero", () => {
  expect(readUsage(null, false)).toBeNull();
  expect(readUsage({}, false)).toBeNull();
  expect(readUsage(undefined, true)).toBeNull();
});

test("provider cache accounting", () => {
  const codex = readUsage({ input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 }, false)!;
  const claude = readUsage(
    { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 15 },
    true,
  )!;
  // Claude adds cache reads and writes to input; Codex's cached tokens are already inside input.
  expect(codex.tokensIn + codex.tokensOut + claude.tokensIn + claude.tokensOut).toBe(190);
  expect(codex.tokensIn + claude.tokensIn).toBe(165);
  expect(codex.tokensCached + claude.tokensCached).toBe(120);
});

test("a cached count larger than the input is not trusted", () => {
  expect(readUsage({ input_tokens: 5, output_tokens: 1, cached_input_tokens: 9 }, false)).toBeNull();
});

test("an unpriced model has no cost, a priced one bills cache reads at the cache rate", () => {
  expect(costFor("gpt-not-priced", { tokensIn: 1, tokensOut: 1 })).toBeUndefined();
  expect(costFor(null, { tokensIn: 1, tokensOut: 1 })).toBeUndefined();
  // haiku 4.5: 20 fresh in at $1, 80 cached at $0.10, 10 out at $5, per million.
  expect(costFor("claude-haiku-4-5-20251001", { tokensIn: 100, tokensOut: 10, tokensCached: 80 })).toBeCloseTo(
    (20 * 1 + 80 * 0.1 + 10 * 5) / 1e6,
    12,
  );
});
