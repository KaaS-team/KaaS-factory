// The shapes of the plan-versus-reality summary: plain data in, one comparable record out.

import type { Risk } from "../artifacts";

export const ROW_STATUSES = ["met", "met-late", "deviation", "not-met", "not-recorded", "info"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface ReviewCounts {
  found: number;
  fixed: number;
  dismissed: number;
  open: number;
}

export interface QaCounts {
  passed: number;
  total: number;
}

export interface SummaryInput {
  plan: {
    goal: string;
    risk: Risk;
    files: string[];
    criteria: string[];
    nonGoals: string[];
  };
  actual: {
    touched: string[];
    riskAtHead?: Risk;
    criteria: { text: string; ok: boolean }[];
    notProven: string[];
    /** Runs per stage name, for example `{ build: 1, verify: 2 }`. */
    stages: Record<string, number>;
    rejectRounds: number;
    retries: number;
    takeover: boolean;
    review?: ReviewCounts;
    qa?: QaCounts;
  };
  operator?: Record<string, unknown>;
}

export interface SummaryRow {
  row: string;
  planned: string;
  actual: string | null;
  status: RowStatus;
  detail?: string;
}

export interface SummaryV1 {
  apiVersion: "factory.summary/v1";
  oneLine: string;
  outcome: string;
  planVsReality: SummaryRow[];
  deviations: string[];
  notProven: string[];
  operator?: Record<string, unknown>;
}
