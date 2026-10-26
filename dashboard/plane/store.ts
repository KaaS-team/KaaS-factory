// Who may steer the factory, and what they did. Its own tables, so a plane can
// share the runner's state file or stand alone; deleting it never touches runs.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ROLES = ["viewer", "approver", "operator", "owner"] as const;
export type Role = (typeof ROLES)[number];

export function atLeast(have: Role, need: Role): boolean {
  return ROLES.indexOf(have) >= ROLES.indexOf(need);
}

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export interface Member {
  login: string;
  role: Role;
  added_by: string;
  added_at: string;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  role: string;
  route: string;
  issue: number | null;
  status: number;
}

const MAX_SESSIONS = 1000;
export interface AuditLimits {
  rows: number;
  refusals: number;
  every: number;
}
// Enough for months of clicks on one plane; ee/ exports the log before it rolls. Refusals roll in
// their own budget, so a caller spamming 403s cannot push members' real writes out of the log.
const LIMITS: AuditLimits = { rows: 50_000, refusals: 5_000, every: 1000 };
const PAGE = 200;

// A leaked database must not hand out live sessions, so only the digest is kept.
const digest = (id: string) => createHash("sha256").update(id).digest("hex");

export class PlaneStore {
  private readonly db: Database;

  constructor(
    path = ":memory:",
    private readonly limits = LIMITS,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plane_users (
        login TEXT PRIMARY KEY,
        github_id INTEGER,
        name TEXT,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_memberships (
        login TEXT PRIMARY KEY,
        github_id INTEGER,
        role TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plane_sessions (
        id_hash TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_sessions_expiry ON plane_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS plane_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        role TEXT NOT NULL,
        route TEXT NOT NULL,
        issue INTEGER,
        status INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS plane_audit_status ON plane_audit (status, id);
    `);
  }

  roleOf(login: string): Role | null {
    const row = this.db.query("SELECT role FROM plane_memberships WHERE login = ?").get(login) as {
      role: string;
    } | null;
    return row && isRole(row.role) ? row.role : null;
  }

  setMember(login: string, role: Role | null, by: string): void {
    if (role === null) {
      this.db.query("DELETE FROM plane_memberships WHERE login = ?").run(login);
      this.db.query("DELETE FROM plane_sessions WHERE login = ?").run(login);
      return;
    }
    this.db
      .query(
        `INSERT INTO plane_memberships (login, role, added_by, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (login) DO UPDATE SET role = excluded.role, added_by = excluded.added_by`,
      )
      .run(login, role, by, new Date().toISOString());
  }

  // A login can be renamed and then registered by someone else, so the first sign-in pins the
  // GitHub account id and a later sign-in from another account is refused.
  claim(login: string, githubId: number): boolean {
    this.db
      .query("UPDATE plane_memberships SET github_id = ? WHERE login = ? AND github_id IS NULL")
      .run(githubId, login);
    const row = this.db.query("SELECT github_id FROM plane_memberships WHERE login = ?").get(login) as {
      github_id: number | null;
    } | null;
    return row?.github_id === githubId;
  }

  members(): Member[] {
    return this.db
      .query("SELECT login, role, added_by, added_at FROM plane_memberships ORDER BY login LIMIT 500")
      .all() as Member[];
  }

  seen(login: string, githubId: number | null, name: string | null): void {
    this.db
      .query(
        `INSERT INTO plane_users (login, github_id, name, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (login) DO UPDATE SET github_id = excluded.github_id, name = excluded.name, seen_at = excluded.seen_at`,
      )
      .run(login, githubId, name, new Date().toISOString());
  }

  openSession(id: string, login: string, ttlMs: number): void {
    const now = Date.now();
    this.db.query("DELETE FROM plane_sessions WHERE expires_at <= ?").run(now);
    this.db
      .query(
        `DELETE FROM plane_sessions WHERE id_hash IN
         (SELECT id_hash FROM plane_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET ?)`,
      )
      .run(MAX_SESSIONS - 1);
    this.db.query("INSERT INTO plane_sessions VALUES (?, ?, ?)").run(digest(id), login, now + ttlMs);
  }

  sessionLogin(id: string): string | null {
    if (!id) return null;
    const row = this.db
      .query("SELECT login FROM plane_sessions WHERE id_hash = ? AND expires_at > ?")
      .get(digest(id), Date.now()) as { login: string } | null;
    return row?.login ?? null;
  }

  closeSession(id: string): void {
    this.db.query("DELETE FROM plane_sessions WHERE id_hash = ?").run(digest(id));
  }

  record(row: Omit<AuditRow, "id" | "at">): void {
    const r = this.db
      .query("INSERT INTO plane_audit (at, actor, role, route, issue, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), row.actor, row.role, row.route, row.issue, row.status);
    if (Number(r.lastInsertRowid) % this.limits.every !== 0) return;
    for (const [refused, keep] of [
      [1, this.limits.refusals],
      [0, this.limits.rows],
    ] as const)
      this.db
        .query(
          `DELETE FROM plane_audit WHERE (status = 403) = ? AND id <
           (SELECT id FROM plane_audit WHERE (status = 403) = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        )
        .run(refused, refused, keep - 1);
  }

  // Keyset paging: newest first, `before` is the last id the caller saw.
  audit(before?: number): AuditRow[] {
    return this.db
      .query("SELECT * FROM plane_audit WHERE id < ? ORDER BY id DESC LIMIT ?")
      .all(before ?? Number.MAX_SAFE_INTEGER, PAGE) as AuditRow[];
  }
}
