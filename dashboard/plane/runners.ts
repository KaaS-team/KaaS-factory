// Runners that dial out: registered once by a one-time token, they follow an SSE stream and post
// results back. A lease silent for 60s is requeued, so a dead machine never holds an issue, and a
// mid-run message stays undoable here until the runner says it read it.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { digest } from "./store";

export const HEARTBEAT_MS = 15_000;
export const LEASE_SILENCE_MS = 60_000;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const NAME = /^[\w.-]{1,64}$/;

export interface RunnerRow {
  id: string;
  name: string;
  registered_at: string;
  last_seen: number;
}
export interface RunnerEvent {
  seq: number;
  type: string;
  data: string;
}
export type Signal = "cancel" | "takeover";
// One issue in one repo: issue numbers repeat across repos, so neither half names a job alone.
export interface Job {
  repo: string;
  issue: number;
}

export class RunnerHub {
  constructor(
    private readonly db: Database,
    readonly now = Date.now,
    defaultRepo = "",
  ) {
    // Jobs and messages keyed by issue alone predate multi-repo planes, when every row was the
    // default repo's. With no default there is no repo to give them, and a job is dispatched again.
    const keyedByIssue = (t: string) => {
      const cols = (db.query("SELECT name FROM pragma_table_info(?)").all(t) as { name: string }[]).map((c) => c.name);
      return cols.length > 0 && !cols.includes("repo");
    };
    const legacy = ["plane_jobs", "plane_messages"].filter(keyedByIssue);
    if (legacy.includes("plane_jobs")) db.exec("ALTER TABLE plane_jobs RENAME TO plane_jobs_by_issue");
    if (legacy.includes("plane_messages")) db.exec("ALTER TABLE plane_messages RENAME TO plane_messages_by_issue");
    db.exec(`
      CREATE TABLE IF NOT EXISTS plane_runner_tokens (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plane_runners (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_runner_repos (
        runner TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (runner, repo)
      );
      CREATE TABLE IF NOT EXISTS plane_jobs (
        repo TEXT NOT NULL, issue INTEGER NOT NULL, state TEXT NOT NULL, runner TEXT, leased_at INTEGER,
        PRIMARY KEY (repo, issue)
      );
      CREATE TABLE IF NOT EXISTS plane_runner_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, runner TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_runner_events_runner ON plane_runner_events (runner, seq);
      CREATE TABLE IF NOT EXISTS plane_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, issue INTEGER NOT NULL, text TEXT NOT NULL,
        by TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL
      );
    `);
    db.transaction(() => {
      if (defaultRepo && legacy.includes("plane_jobs"))
        db.query(
          "INSERT INTO plane_jobs (repo, issue, state, runner, leased_at) SELECT ?, issue, state, runner, leased_at FROM plane_jobs_by_issue",
        ).run(defaultRepo);
      if (defaultRepo && legacy.includes("plane_messages"))
        db.query(
          "INSERT INTO plane_messages (id, repo, issue, text, by, state, at) SELECT id, ?, issue, text, by, state, at FROM plane_messages_by_issue",
        ).run(defaultRepo);
      db.exec("DROP TABLE IF EXISTS plane_jobs_by_issue; DROP TABLE IF EXISTS plane_messages_by_issue");
    })();
  }

  issueToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.db.query("DELETE FROM plane_runner_tokens WHERE expires_at <= ?").run(this.now());
    this.db.query("INSERT INTO plane_runner_tokens VALUES (?, ?)").run(digest(token), this.now() + TOKEN_TTL_MS);
    return token;
  }

  // The token works once; the secret it returns is shown once and only its digest is kept.
  register(token: string, name: string): { id: string; secret: string } | null {
    if (!NAME.test(name)) return null;
    const hit = this.db
      .query("DELETE FROM plane_runner_tokens WHERE token_hash = ? AND expires_at > ? RETURNING token_hash")
      .get(digest(token), this.now());
    if (!hit) return null;
    const id = randomBytes(9).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    this.db
      .query("INSERT INTO plane_runners VALUES (?, ?, ?, ?, ?)")
      .run(id, name, digest(secret), new Date(this.now()).toISOString(), this.now());
    return { id, secret };
  }

  runnerOf(secret: string): string | null {
    if (!secret) return null;
    const row = this.db.query("SELECT id FROM plane_runners WHERE secret_hash = ?").get(digest(secret)) as {
      id: string;
    } | null;
    return row?.id ?? null;
  }

  list(): (RunnerRow & { online: boolean; repos: string[]; leases: Job[] })[] {
    const rows = this.db
      .query("SELECT id, name, registered_at, last_seen FROM plane_runners ORDER BY name")
      .all() as RunnerRow[];
    return rows.map((r) => ({
      ...r,
      online: this.online(r.last_seen),
      repos: this.reposOf(r.id),
      leases: this.leasesOf(r.id),
    }));
  }

  reposOf(runner: string): string[] {
    return (
      this.db.query("SELECT repo FROM plane_runner_repos WHERE runner = ? ORDER BY repo").all(runner) as {
        repo: string;
      }[]
    ).map((r) => r.repo);
  }

  private online(lastSeen: number): boolean {
    return this.now() - lastSeen < LEASE_SILENCE_MS;
  }

  leasesOf(runner: string): Job[] {
    return this.db
      .query("SELECT repo, issue FROM plane_jobs WHERE state = 'leased' AND runner = ? ORDER BY repo, issue")
      .all(runner) as Job[];
  }

  holder(job: Job): string | null {
    const row = this.db
      .query("SELECT runner FROM plane_jobs WHERE repo = ? AND issue = ? AND state = 'leased'")
      .get(job.repo, job.issue) as { runner: string } | null;
    return row?.runner ?? null;
  }

  private emit(runner: string, type: string, data: unknown): void {
    this.db
      .query("INSERT INTO plane_runner_events (runner, type, data) VALUES (?, ?, ?)")
      .run(runner, type, JSON.stringify(data));
  }

  events(runner: string, after: number): RunnerEvent[] {
    return this.db
      .query("SELECT seq, type, data FROM plane_runner_events WHERE runner = ? AND seq > ? ORDER BY seq LIMIT 100")
      .all(runner, after) as RunnerEvent[];
  }

  // A runner names the repos it holds a checkout of; it is leased work in those repos only.
  heartbeat(runner: string, repos?: readonly string[]): void {
    this.db.query("UPDATE plane_runners SET last_seen = ? WHERE id = ?").run(this.now(), runner);
    if (repos) {
      this.db.query("DELETE FROM plane_runner_repos WHERE runner = ?").run(runner);
      for (const r of repos) this.db.query("INSERT OR IGNORE INTO plane_runner_repos VALUES (?, ?)").run(runner, r);
    }
    this.sweep();
  }

  enqueue(job: Job): void {
    this.db
      .query("INSERT INTO plane_jobs (repo, issue, state) VALUES (?, ?, 'queued') ON CONFLICT DO NOTHING")
      .run(job.repo, job.issue);
    this.dispatch();
  }

  // Requeue every lease whose runner went silent, then hand queued work to runners still heard from.
  sweep(): void {
    this.db
      .query(
        `UPDATE plane_jobs SET state = 'queued', runner = NULL, leased_at = NULL
         WHERE state = 'leased' AND runner IN (SELECT id FROM plane_runners WHERE last_seen <= ?)`,
      )
      .run(this.now() - LEASE_SILENCE_MS);
    this.dispatch();
  }

  // Work waits for a runner that holds its repo; a runner with no checkout of it never sees it.
  private dispatch(): void {
    const queued = this.db
      .query("SELECT repo, issue FROM plane_jobs WHERE state = 'queued' ORDER BY repo, issue")
      .all() as Job[];
    for (const job of queued) {
      const live = this.list().filter((r) => r.online && r.repos.includes(job.repo));
      if (live.length === 0) continue;
      const runner = live.sort((a, b) => a.leases.length - b.leases.length)[0]!;
      this.db
        .query("UPDATE plane_jobs SET state = 'leased', runner = ?, leased_at = ? WHERE repo = ? AND issue = ?")
        .run(runner.id, this.now(), job.repo, job.issue);
      this.emit(runner.id, "lease", job);
      for (const m of this.queuedMessages(job)) this.emit(runner.id, "message", { id: m.id, ...job, text: m.text });
    }
  }

  done(runner: string, job: Job): boolean {
    const r = this.db
      .query("UPDATE plane_jobs SET state = 'done' WHERE repo = ? AND issue = ? AND runner = ? AND state = 'leased'")
      .run(job.repo, job.issue, runner);
    return r.changes > 0;
  }

  private queuedMessages(job: Job): { id: number; text: string }[] {
    return this.db
      .query("SELECT id, text FROM plane_messages WHERE repo = ? AND issue = ? AND state = 'queued' ORDER BY id")
      .all(job.repo, job.issue) as {
      id: number;
      text: string;
    }[];
  }

  message(job: Job, text: string, by: string): number {
    const r = this.db
      .query("INSERT INTO plane_messages (repo, issue, text, by, state, at) VALUES (?, ?, ?, ?, 'queued', ?)")
      .run(job.repo, job.issue, text, by, new Date(this.now()).toISOString());
    const id = Number(r.lastInsertRowid);
    const runner = this.holder(job);
    if (runner) this.emit(runner, "message", { id, ...job, text });
    return id;
  }

  messages(job: Job): { id: number; text: string; by: string; state: string; at: string }[] {
    return this.db
      .query(
        "SELECT id, text, by, state, at FROM plane_messages WHERE repo = ? AND issue = ? ORDER BY id DESC LIMIT 50",
      )
      .all(job.repo, job.issue) as {
      id: number;
      text: string;
      by: string;
      state: string;
      at: string;
    }[];
  }

  // Undo works only while the message is still queued; once a runner read it, it is the agent's.
  undo(job: Job, id: number): boolean {
    return (
      this.db
        .query(
          "UPDATE plane_messages SET state = 'undone' WHERE id = ? AND repo = ? AND issue = ? AND state = 'queued'",
        )
        .run(id, job.repo, job.issue).changes > 0
    );
  }

  // The runner asks before handing a message to the agent; an undone one is refused here.
  read(runner: string, id: number): boolean {
    const row = this.db.query("SELECT repo, issue FROM plane_messages WHERE id = ?").get(id) as Job | null;
    if (!row || this.holder(row) !== runner) return false;
    return (
      this.db.query("UPDATE plane_messages SET state = 'read' WHERE id = ? AND state = 'queued'").run(id).changes > 0
    );
  }

  // Tells the runner holding the issue to stop or hand over its running stage; null when none holds it.
  signal(job: Job, type: Signal, by: string): string | null {
    const runner = this.holder(job);
    if (runner) this.emit(runner, type, { ...job, by });
    return runner;
  }
}
