// Spend on GitHub, so every worker on every machine reads the same caps.
//
// - An issue's spend: on the issue, one hidden-marker comment per worker.
// - The repo's daily spend: on the ledger issue (label factory:ledger), one
//   comment per worker per UTC day.
//
// Each comment has exactly one writer (the worker named in it) and holds that
// worker's running total, so there is no edit race between workers; readers
// sum every worker's comment. A marker anyone could forge only ever adds:
// negative or non-numeric values are dropped, so a forgery can park an issue
// early but never lift a cap. Two workers that both create a ledger issue
// at once is harmless too: readers sum every open ledger issue.

import type { GitHub } from "../../github";
import { LABEL, LABELS } from "../../labels";
import type { GhComment } from "../../ports/scm";
import type { SpendEntry, SpendStore, SpendTotal } from "../../ports/spend";

const MARKER_RE = /<!-- factory:spend (\{.*?\}) -->/g;

interface Tally {
  readonly holder: string;
  // The UTC day (YYYY-MM-DD) on a ledger comment; absent on an issue's.
  readonly day?: string;
  readonly costUsd: number;
  readonly unreportedRuns: number;
  readonly runs: number;
}

function tallies(comments: readonly GhComment[]): Tally[] {
  const out: Tally[] = [];
  for (const c of comments) {
    for (const m of c.body.matchAll(MARKER_RE)) {
      try {
        const t = JSON.parse(m[1]!) as Partial<Tally>;
        const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
        if (typeof t.holder === "string" && ok(t.costUsd) && ok(t.unreportedRuns) && ok(t.runs)) out.push(t as Tally);
      } catch {
        // Not ours, or hand-typed: not data.
      }
    }
  }
  return out;
}

const sum = (ts: readonly Tally[]): SpendTotal => ({
  costUsd: ts.reduce((a, t) => a + t.costUsd, 0),
  unreportedRuns: ts.reduce((a, t) => a + t.unreportedRuns, 0),
});

// The REST id from a comment `gh` returned, or the fake's numeric id.
function restId(c: GhComment): number | undefined {
  const m = c.url?.match(/#issuecomment-(\d+)$/);
  if (m) return Number(m[1]);
  return typeof c.id === "number" ? c.id : undefined;
}

type Scm = Pick<GitHub, "getIssue" | "commentIssue" | "editComment" | "listIssuesByLabel" | "createIssue" | "ensureLabel">;

export class GitHubSpend implements SpendStore {
  private readonly ids = new Map<string, number>();
  private readonly totals = new Map<string, Tally>();
  private chain = Promise.resolve();
  private ledger?: number;

  constructor(private readonly scm: Scm, private readonly repo: string, private readonly holder: string) {}

  record(e: SpendEntry): Promise<void> {
    // One write at a time: two stages finishing together would otherwise both read and write this worker's ledger comment.
    const next = this.chain.then(async () => {
      // Issue 0 is a minion's run: it has no issue, so only the ledger counts it.
      if (e.issue > 0) await this.add(e.issue, undefined, e);
      await this.add(await this.ledgerIssue(), e.at.slice(0, 10), e);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  async issue(issue: number): Promise<SpendTotal> {
    return sum(tallies((await this.scm.getIssue(this.repo, issue)).comments).filter((t) => t.day === undefined));
  }

  async since(sinceIso: string): Promise<SpendTotal> {
    const day = sinceIso.slice(0, 10);
    const ledgers = await this.scm.listIssuesByLabel(this.repo, LABEL.ledger);
    return sum(ledgers.flatMap((i) => tallies(i.comments)).filter((t) => t.day !== undefined && t.day >= day));
  }

  private async ledgerIssue(): Promise<number> {
    if (this.ledger !== undefined) return this.ledger;
    const open = await this.scm.listIssuesByLabel(this.repo, LABEL.ledger);
    if (!open[0]) {
      // A repo set up before v3.3 has no ledger label, and gh will not create an issue with a missing one.
      const label = LABELS.find((l) => l.name === LABEL.ledger)!;
      await this.scm.ensureLabel(this.repo, label.name, label.color, label.description);
    }
    this.ledger = open[0]?.number ?? (await this.scm.createIssue(this.repo, "Factory spend ledger", "Each worker keeps one comment per UTC day here with its spend. The factory reads them for spend.dailyUsd; please leave this issue open.", [LABEL.ledger]));
    return this.ledger;
  }

  private async add(issue: number, day: string | undefined, e: SpendEntry): Promise<void> {
    const key = `${issue}/${day ?? ""}`;
    let id = this.ids.get(key);
    let cur = this.totals.get(key);
    if (id === undefined) {
      const mine = (await this.scm.getIssue(this.repo, issue)).comments.find((c) => tallies([c]).some((t) => t.holder === this.holder && t.day === day));
      if (mine) {
        id = restId(mine);
        cur = tallies([mine])[0];
      }
    }
    const next: Tally = {
      holder: this.holder,
      ...(day ? { day } : {}),
      costUsd: (cur?.costUsd ?? 0) + (e.costUsd ?? 0),
      unreportedRuns: (cur?.unreportedRuns ?? 0) + (e.costUsd === null ? 1 : 0),
      runs: (cur?.runs ?? 0) + 1,
    };
    const body = `Factory spend${day ? ` on ${day}` : ""} by worker ${this.holder}: $${next.costUsd.toFixed(2)} over ${next.runs} stage run(s)${next.unreportedRuns ? `, ${next.unreportedRuns} with unknown cost` : ""}.\n<!-- factory:spend ${JSON.stringify(next)} -->`;
    if (id !== undefined) await this.scm.editComment(this.repo, id, body);
    else id = await this.scm.commentIssue(this.repo, issue, body);
    if (id !== undefined) this.ids.set(key, id);
    this.totals.set(key, next);
  }
}
