// Ported from owainlewis/machinist@3943516 internal/runner/codex_usage.go:455-473 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the cut is by code point in JS, which is the same rune-boundary rule.

export const MAX_FINAL_MESSAGE_BYTES = 16 * 1024;
const TRUNCATION_MARK = "\n\n[truncated]";

// The agent's last message, shown as the run summary. Cut on a character
// boundary so a multi-byte character is never split.
export function truncateFinalMessage(text: string): string {
  const message = text.trim();
  if (Buffer.byteLength(message) <= MAX_FINAL_MESSAGE_BYTES) return message;
  let out = "";
  let used = 0;
  for (const ch of message) {
    const n = Buffer.byteLength(ch);
    if (used + n > MAX_FINAL_MESSAGE_BYTES) break;
    out += ch;
    used += n;
  }
  return out + TRUNCATION_MARK;
}
