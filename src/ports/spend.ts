// Where spend is recorded and caps are read. SQLite on this machine is one
// adapter; GitHub (comments on the issue and on a ledger issue) is the one
// every worker on every machine shares, so a cap holds across all of them.

export interface SpendEntry {
  readonly issue: number;
  readonly stage: string;
  // null: the agent reported no usage, so the cost is unknown (never $0).
  readonly costUsd: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  // ISO time the stage started.
  readonly at: string;
}

export interface SpendTotal {
  readonly costUsd: number;
  readonly unreportedRuns: number;
}

export interface SpendStore {
  record(entry: SpendEntry): Promise<void>;
  // An issue's lifetime spend.
  issue(issue: number): Promise<SpendTotal>;
  // The repo's spend since `sinceIso`, which is 00:00 UTC of some day.
  since(sinceIso: string): Promise<SpendTotal>;
}
