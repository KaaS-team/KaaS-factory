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

export class RunnerHub {
  constructor(
    private readonly db: Database,
    readonly now = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS plane_runner_tokens (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plane_runners (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_jobs (
        issue INTEGER PRIMARY KEY, state TEXT NOT NULL, runner TEXT, leased_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS plane_runner_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, runner TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_runner_events_runner ON plane_runner_events (runner, seq);
      CREATE TABLE IF NOT EXISTS plane_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, text TEXT NOT NULL,
        by TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL
      );
    `);
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

  list(): (RunnerRow & { online: boolean; leases: number[] })[] {
    const rows = this.db
      .query("SELECT id, name, registered_at, last_seen FROM plane_runners ORDER BY name")
      .all() as RunnerRow[];
    return rows.map((r) => ({ ...r, online: this.online(r.last_seen), leases: this.leasesOf(r.id) }));
  }

  private online(lastSeen: number): boolean {
    return this.now() - lastSeen < LEASE_SILENCE_MS;
  }

  leasesOf(runner: string): number[] {
    return (
      this.db
        .query("SELECT issue FROM plane_jobs WHERE state = 'leased' AND runner = ? ORDER BY issue")
        .all(runner) as { issue: number }[]
    ).map((r) => r.issue);
  }

  holder(issue: number): string | null {
    const row = this.db.query("SELECT runner FROM plane_jobs WHERE issue = ? AND state = 'leased'").get(issue) as {
      runner: string;
    } | null;
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

  heartbeat(runner: string): void {
    this.db.query("UPDATE plane_runners SET last_seen = ? WHERE id = ?").run(this.now(), runner);
    this.sweep();
  }

  enqueue(issue: number): void {
    this.db
      .query("INSERT INTO plane_jobs (issue, state) VALUES (?, 'queued') ON CONFLICT (issue) DO NOTHING")
      .run(issue);
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

  private dispatch(): void {
    const queued = this.db.query("SELECT issue FROM plane_jobs WHERE state = 'queued' ORDER BY issue").all() as {
      issue: number;
    }[];
    for (const { issue } of queued) {
      const live = this.list().filter((r) => r.online);
      if (live.length === 0) return;
      const runner = live.sort((a, b) => a.leases.length - b.leases.length)[0]!;
      this.db
        .query("UPDATE plane_jobs SET state = 'leased', runner = ?, leased_at = ? WHERE issue = ?")
        .run(runner.id, this.now(), issue);
      this.emit(runner.id, "lease", { issue });
      for (const m of this.queuedMessages(issue)) this.emit(runner.id, "message", { id: m.id, issue, text: m.text });
    }
  }

  done(runner: string, issue: number): boolean {
    const r = this.db
      .query("UPDATE plane_jobs SET state = 'done' WHERE issue = ? AND runner = ? AND state = 'leased'")
      .run(issue, runner);
    return r.changes > 0;
  }

  private queuedMessages(issue: number): { id: number; text: string }[] {
    return this.db
      .query("SELECT id, text FROM plane_messages WHERE issue = ? AND state = 'queued' ORDER BY id")
      .all(issue) as {
      id: number;
      text: string;
    }[];
  }

  message(issue: number, text: string, by: string): number {
    const r = this.db
      .query("INSERT INTO plane_messages (issue, text, by, state, at) VALUES (?, ?, ?, 'queued', ?)")
      .run(issue, text, by, new Date(this.now()).toISOString());
    const id = Number(r.lastInsertRowid);
    const runner = this.holder(issue);
    if (runner) this.emit(runner, "message", { id, issue, text });
    return id;
  }

  messages(issue: number): { id: number; text: string; by: string; state: string; at: string }[] {
    return this.db
      .query("SELECT id, text, by, state, at FROM plane_messages WHERE issue = ? ORDER BY id DESC LIMIT 50")
      .all(issue) as {
      id: number;
      text: string;
      by: string;
      state: string;
      at: string;
    }[];
  }

  // Undo works only while the message is still queued; once a runner read it, it is the agent's.
  undo(issue: number, id: number): boolean {
    return (
      this.db
        .query("UPDATE plane_messages SET state = 'undone' WHERE id = ? AND issue = ? AND state = 'queued'")
        .run(id, issue).changes > 0
    );
  }

  // The runner asks before handing a message to the agent; an undone one is refused here.
  read(runner: string, id: number): boolean {
    const row = this.db.query("SELECT issue FROM plane_messages WHERE id = ?").get(id) as { issue: number } | null;
    if (!row || this.holder(row.issue) !== runner) return false;
    return (
      this.db.query("UPDATE plane_messages SET state = 'read' WHERE id = ? AND state = 'queued'").run(id).changes > 0
    );
  }

  // Tells the runner holding the issue to stop or hand over its running stage; null when none holds it.
  signal(issue: number, type: Signal, by: string): string | null {
    const runner = this.holder(issue);
    if (runner) this.emit(runner, type, { issue, by });
    return runner;
  }
}
