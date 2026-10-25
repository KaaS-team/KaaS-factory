// Ported from owainlewis/machinist@3943516 internal/runner/events.go:14-90 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the bound applies to a run's rows in the events table rather than to a JSONL file; the sequence and base64 encoding are not needed; the seed is the bytes already stored, so a restart keeps the bound.

export const MAX_EVENT_LOG_BYTES = 32 << 20;
// Room kept for the one truncation event, so it always fits.
export const TRUNCATION_EVENT_RESERVE = 1 << 10;
export const TRUNCATION_KIND = "process.output_truncated";

export class EventBudget {
  private truncated = false;

  constructor(
    private used = 0,
    readonly limit = MAX_EVENT_LOG_BYTES,
  ) {}

  // "write" the event, "truncate" to write the marker instead (once), or "drop".
  admit(bytes: number): "write" | "truncate" | "drop" {
    if (this.truncated) return "drop";
    if (this.used + bytes + TRUNCATION_EVENT_RESERVE > this.limit) {
      this.truncated = true;
      return "truncate";
    }
    this.used += bytes;
    return "write";
  }

  message(): string {
    return `recording stopped after ${this.limit} event bytes; live output continues`;
  }
}
