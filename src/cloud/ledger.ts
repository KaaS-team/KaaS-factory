import { TERMINAL, type CloudStatus } from "./port";

type Reservation = { provider: string; attempt: number; at: number; usd?: number };
type Session = { provider: string; id: string; startedAt: number; status: CloudStatus; baseSha: string };

export type CloudLedgerJson = {
  reservations: Record<string, Reservation>;
  sessions: Record<string, Session>;
};

function keyFor(repo: string): string {
  return `cloud:${repo}`;
}

function empty(): CloudLedgerJson {
  return { reservations: {}, sessions: {} };
}

function load(state: { getSetting(k: string): string | undefined }, repo: string): CloudLedgerJson {
  const raw = state.getSetting(keyFor(repo));
  if (!raw) return empty();
  return JSON.parse(raw) as CloudLedgerJson;
}

function save(state: { setSetting(k: string, v: string): void }, repo: string, data: CloudLedgerJson): void {
  state.setSetting(keyFor(repo), JSON.stringify(data));
}

function countsReservation(r: Reservation): boolean {
  return r.provider.length > 0;
}

export function cloudLedger(
  state: { getSetting(k: string): string | undefined; setSetting(k: string, v: string): void },
  repo: string,
) {
  return {
    // `usd` is the spend held back for the run until it settles.
    reserve(issue: number, provider: string, usd?: number): number {
      const data = load(state, repo);
      const k = String(issue);
      const prior = data.reservations[k];
      let attempt = 1;
      if (prior && prior.provider === "") attempt = prior.attempt + 1;
      data.reservations[k] = { provider, attempt, at: Date.now(), ...(usd === undefined ? {} : { usd }) };
      save(state, repo, data);
      return attempt;
    },

    reservation(issue: number): Reservation | undefined {
      return load(state, repo).reservations[String(issue)];
    },

    started(issue: number, provider: string, id: string, baseSha: string): void {
      const data = load(state, repo);
      const k = String(issue);
      data.sessions[k] = {
        provider,
        id,
        startedAt: Date.now(),
        status: "running",
        baseSha,
      };
      save(state, repo, data);
    },

    session(issue: number): Session | undefined {
      return load(state, repo).sessions[String(issue)];
    },

    settle(issue: number, status: CloudStatus): void {
      const data = load(state, repo);
      const k = String(issue);
      const attempt = data.reservations[k]?.attempt ?? 1;
      delete data.reservations[k];
      const sess = data.sessions[k];
      if (sess) sess.status = status;
      if (status !== "finished") {
        data.reservations[k] = { provider: "", attempt, at: Date.now() };
      }
      save(state, repo, data);
    },

    release(issue: number): void {
      const data = load(state, repo);
      delete data.reservations[String(issue)];
      save(state, repo, data);
    },

    reservedUsd(): number {
      const held = load(state, repo).reservations;
      let total = 0;
      for (const k in held) total += held[k]?.usd ?? 0;
      return total;
    },

    all(): CloudLedgerJson {
      return load(state, repo);
    },

    active(): Record<string, number> {
      const data = load(state, repo);
      const counts: Record<string, number> = {};
      for (const r of Object.values(data.reservations)) {
        if (!countsReservation(r)) continue;
        counts[r.provider] = (counts[r.provider] ?? 0) + 1;
      }
      for (const s of Object.values(data.sessions)) {
        if (TERMINAL.has(s.status)) continue;
        counts[s.provider] = (counts[s.provider] ?? 0) + 1;
      }
      return counts;
    },

    expire(liveIssues: ReadonlySet<number>, nowMs: number, maxAgeMs: number): number[] {
      const data = load(state, repo);
      const dropped: number[] = [];
      const resMap = data.reservations;
      for (const [k, r] of Object.entries(resMap)) {
        const issue = Number(k);
        if (!liveIssues.has(issue) || nowMs - r.at > maxAgeMs) {
          delete data.reservations[k];
          dropped.push(issue);
        }
      }
      for (const [k, s] of Object.entries(data.sessions)) {
        const issue = Number(k);
        if (!liveIssues.has(issue) || nowMs - s.startedAt > maxAgeMs) {
          delete data.sessions[k];
          if (!dropped.includes(issue)) dropped.push(issue);
        }
      }
      save(state, repo, data);
      return dropped.sort((a, b) => a - b);
    },
  };
}
