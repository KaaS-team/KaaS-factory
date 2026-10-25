// Ported from owainlewis/machinist@3943516 internal/runner/codex_usage.go:508-640 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: cache reads are reported apart as tokensCached, from evals/agent.py record_usage (Codex cached_input_tokens is optional and already inside input); input and output tokens are returned apart (machinist sums them into one number); int64 overflow is any value past Number.MAX_SAFE_INTEGER; the candidate scan is a depth-aware string scanner rather than a json.Decoder.

// A terminal event's token usage, or null when it cannot be trusted. The last
// terminal event wins; a bad one makes usage "not reported" rather than zero.
export interface TokenUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  // Cache reads, a subset of tokensIn (machinist agent.py record_usage).
  readonly tokensCached: number;
}

const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

// Codex: input + output. Claude (`cache`): input + cache creation + cache read + output.
export function readUsage(raw: unknown, cache: boolean): TokenUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  if (input === null || output === null) return null;
  let tokensIn = input;
  let cached = 0;
  if (cache) {
    const created = count(u.cache_creation_input_tokens);
    const read = count(u.cache_read_input_tokens);
    if (created === null || read === null) return null;
    tokensIn += created + read;
    cached = read;
  } else if (u.cached_input_tokens !== undefined) {
    const c = count(u.cached_input_tokens);
    if (c === null || c > input) return null;
    cached = c;
  }
  return Number.isSafeInteger(tokensIn + output) ? { tokensIn, tokensOut: output, tokensCached: cached } : null;
}

// True when the line's own top-level "type" is `resultType`, even if the rest
// of the line is cut off or malformed. A nested `"type"` does not count.
export function isUsageResultCandidate(line: string, resultType: string): boolean {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
      if (j >= line.length) return false;
      const key = line.slice(i + 1, j);
      i = j;
      if (depth === 1 && key === "type") {
        const m = /^\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line.slice(j + 1));
        return m !== null && m[1] === resultType;
      }
    }
  }
  return false;
}
