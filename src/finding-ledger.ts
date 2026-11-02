import type { VerdictArtifact } from "./artifacts";
import { stableId } from "./finding-disposition";

export interface LedgerRow {
  id: string;
  what: string;
  where?: string;
  status: "open" | "resolved";
  firstRound: number;
  lastRound: number;
  reopened: number;
}

const mustFindings = (v: VerdictArtifact): { id: string; what: string; where?: string }[] =>
  v.findings.flatMap((f) => {
    if (typeof f === "string") return [{ id: stableId(f), what: f }];
    if (f.severity !== "must") return [];
    return [{ id: stableId(f), what: f.what, where: f.where }];
  });

export function seedLedger(prior: readonly string[]): LedgerRow[] {
  const rows = prior.map(
    (what): LedgerRow => ({
      id: stableId(what),
      what,
      status: "open",
      firstRound: 0,
      lastRound: 0,
      reopened: 0,
    }),
  );
  return sortRows(rows);
}

export function mergeLedger(rows: readonly LedgerRow[], verdict: VerdictArtifact): LedgerRow[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const round = verdict.rounds;
  for (const f of mustFindings(verdict)) {
    const prev = byId.get(f.id);
    if (!prev) {
      byId.set(f.id, {
        id: f.id,
        what: f.what,
        where: f.where,
        status: "open",
        firstRound: round,
        lastRound: round,
        reopened: 0,
      });
      continue;
    }
    const reopened = prev.status === "resolved" ? prev.reopened + 1 : prev.reopened;
    byId.set(f.id, {
      ...prev,
      what: f.what,
      where: f.where ?? prev.where,
      status: "open",
      lastRound: round,
      reopened,
    });
  }
  for (const p of verdict.prior ?? []) {
    if (p.status !== "resolved") continue;
    for (const row of byId.values()) {
      if (row.what === p.what && row.status === "open") row.status = "resolved";
    }
  }
  return sortRows([...byId.values()]);
}

function sortRows(rows: LedgerRow[]): LedgerRow[] {
  return [...rows].sort((a, b) => a.firstRound - b.firstRound || a.id.localeCompare(b.id));
}

export function openWhats(rows: readonly LedgerRow[]): string[] {
  return rows.filter((r) => r.status === "open").map((r) => r.what);
}
