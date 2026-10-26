// A stream of numbered events a runner follows from the plane. Each event carries its sequence
// number, so a dropped connection resumes after the last one seen and nothing is applied twice.

export interface SourceEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
}

export interface EventSourcePort {
  // Delivers events after `after` until the stream ends or `signal` aborts; resolves with the last seq seen.
  follow(after: number, onEvent: (e: SourceEvent) => Promise<void> | void, signal?: AbortSignal): Promise<number>;
}
