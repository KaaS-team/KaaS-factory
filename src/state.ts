// Run telemetry only. GitHub is the record of truth for the conversation; this
// database is what the dashboard reads to draw the board, and what watch.ts
// reads to know what it already did. Safe to delete: `factory reset` wipes it.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { EventBudget, MAX_EVENT_LOG_BYTES, TRUNCATION_KIND } from "./event-budget";
import { dirname } from "node:path";
import { defaultStatePath } from "./paths";

export type Stage = "triage" | "plan" | "build" | "verify" | "pr";

// The final pipeline outcome that triggers a retro (plan v2.10.0 item 3),
// distinct from a stage artifact's own outcome field (complete/blocked/failed).
export type RetroTrigger = "merged" | "rejected" | "gave-up";
export type RetroStatus = "queued" | "done" | "failed";

// One row per final outcome. Queued by all four triggers (checkMergePolicy,
// cancelRun, the verify-reject cap, and the dashboard's operator-merge route);
// only the dashboard trigger, which has no Executor to run retro itself,
// stays "queued" until watch.ts's poll loop drains it.
export interface RetroRow {
  id: number;
  repo: string;
  issue: number;
  outcome: RetroTrigger;
  status: RetroStatus;
  lesson: string | null;
  skill_name: string | null;
  skill_edit: string | null;
  created_at: string;
  completed_at: string | null;
  // Set once `factory learn` (plan v2.10.0 item 4) has batched this row's
  // proposal into a learning PR, so a later run never batches it twice.
  learned_at: string | null;
}
export type RunStatus =
  | "running"
  | "needs-info"
  | "awaiting-approval"
  | "verifying"
  | "rejected"
  | "shipped"
  | "failed"
  | "needs-human"
  | "cancelled";

export interface Run {
  id: number;
  issue: number;
  repo: string;
  title: string;
  stage: Stage;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  gate_line: string | null;
  pr_url: string | null;
  reason: string | null;
  status_comment_id: number | null;
}

export interface RunEvent {
  id: number;
  run_id: number;
  ts: string;
  stage: Stage;
  kind: string;
  text: string;
}

// One row per stage attempt. `runs` holds the latest state of an issue, so a
// retry overwrote what the last attempt cost; this table keeps every attempt.
export interface StageRun {
  id: number;
  repo: string;
  issue: number;
  stage: Stage;
  agent: string;
  model: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  // NULL when the cost is unknown (no price, or usage not fully counted).
  cost_usd: number | null;
  // 0 when tokens or cost are not a full count; the dashboard shows "Not reported".
  usage_complete: number;
  exit_code: number;
  killed_reason: string | null;
  // The agent's resumable session (`factory takeover`); NULL when it reports none.
  session_id: string | null;
  // Verify only: pass, reject or uncertain, set once verdict.json is read (setVerifyVerdict).
  verdict: string | null;
}

// The two v2.5.1 columns default to 0 cached tokens and a complete count; session_id to NULL.
export type StageRunInput = Omit<StageRun, "id" | "tokens_cached" | "usage_complete" | "session_id" | "verdict"> &
  Partial<Pick<StageRun, "tokens_cached" | "usage_complete" | "session_id">>;

// Absolute, rooted at FACTORY_HOME (~/.factory by default, /data in Docker) —
// see paths.ts. A relative path here broke on any machine where the process
// cwd wasn't the target repo (audit finding #1).
export const DEFAULT_DB_PATH = defaultStatePath();

export interface BusEventRow {
  seq?: number;
  id: string;
  direction: "in" | "out";
  type: string;
  source: string;
  subject: string | null;
  time: string;
  data: string;
  handled_at: string | null;
}

export interface BusDeliveryRow {
  id: number;
  event_id: string;
  sink: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  next_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

export class FactoryState {
  private readonly db: Database;

  constructor(path: string = DEFAULT_DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    // The runner and the dashboard open a fresh database at the same moment after a reset.
    // Retry a locked open, and migrate in one write transaction so neither sees half a schema.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    for (let attempt = 0; ; attempt++) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.transaction(() => this.migrate()).immediate();
        return;
      } catch (e) {
        if (attempt >= 20 || !/locked|busy/i.test(String(e))) throw e;
        Bun.sleepSync(25 * (attempt + 1));
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue INTEGER NOT NULL,
        repo TEXT NOT NULL,
        title TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        gate_line TEXT,
        pr_url TEXT,
        reason TEXT,
        status_comment_id INTEGER,
        UNIQUE(repo, issue)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        ts TEXT NOT NULL,
        stage TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_id_id ON events(run_id, id);
      CREATE TABLE IF NOT EXISTS stage_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        stage TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        exit_code INTEGER NOT NULL,
        killed_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS stage_runs_repo_issue_id ON stage_runs(repo, issue, id);
      CREATE TABLE IF NOT EXISTS toggles (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS retros (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        status TEXT NOT NULL,
        lesson TEXT,
        skill_name TEXT,
        skill_edit TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        learned_at TEXT
      );
      CREATE INDEX IF NOT EXISTS retros_repo_status ON retros(repo, status);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        action TEXT NOT NULL,
        repo TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      -- v4.0 event bus: one row per CloudEvent, out (emitted here) or in (POST /events).
      CREATE TABLE IF NOT EXISTS bus_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        direction TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        subject TEXT,
        time TEXT NOT NULL,
        data TEXT NOT NULL,
        handled_at TEXT
      );
      -- One row per (event, sink): the outbox the bus retries until delivered or dead.
      CREATE TABLE IF NOT EXISTS bus_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        sink TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT,
        UNIQUE(event_id, sink)
      );
      CREATE INDEX IF NOT EXISTS bus_deliveries_status_next ON bus_deliveries(status, next_at);
    `);
    // Forward-only and idempotent: safe to run on boot from several replicas.
    const have = new Set(
      (this.db.query("PRAGMA table_info(stage_runs)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [col, ddl] of [
      ["tokens_cached", "INTEGER NOT NULL DEFAULT 0"],
      ["usage_complete", "INTEGER NOT NULL DEFAULT 1"],
      ["session_id", "TEXT"],
      ["verdict", "TEXT"],
    ] as const) {
      if (have.has(col)) continue;
      try {
        this.db.exec(`ALTER TABLE stage_runs ADD COLUMN ${col} ${ddl}`);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    }
    this.makeCostNullable();
  }

  // Databases from before v2.6.1 declare stage_runs.cost_usd NOT NULL DEFAULT 0, so an
  // unknown cost was stored as $0. Rebuild the table once; rows already flagged
  // usage_complete = 0 become NULL. Runs inside the migrate() write transaction.
  private makeCostNullable(): void {
    const cols = this.db.query("PRAGMA table_info(stage_runs)").all() as { name: string; notnull: number }[];
    if (!cols.find((c) => c.name === "cost_usd")?.notnull) return;
    const names = cols.map((c) => c.name).join(", ");
    this.db.exec(`
      CREATE TABLE stage_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        stage TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        exit_code INTEGER NOT NULL,
        killed_reason TEXT,
        tokens_cached INTEGER NOT NULL DEFAULT 0,
        usage_complete INTEGER NOT NULL DEFAULT 1,
        session_id TEXT,
        verdict TEXT
      );
      INSERT INTO stage_runs_new (${names}) SELECT ${names} FROM stage_runs;
      UPDATE stage_runs_new SET cost_usd = NULL WHERE usage_complete = 0;
      DROP TABLE stage_runs;
      ALTER TABLE stage_runs_new RENAME TO stage_runs;
      CREATE INDEX IF NOT EXISTS stage_runs_repo_issue_id ON stage_runs(repo, issue, id);
    `);
  }

  upsertRun(input: { issue: number; repo: string; title: string; stage: Stage; status: RunStatus }): Run {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO runs (issue, repo, title, stage, status, started_at, updated_at)
         VALUES ($issue, $repo, $title, $stage, $status, $now, $now)
         ON CONFLICT(repo, issue) DO UPDATE SET
           title = excluded.title,
           stage = excluded.stage,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run({
        $issue: input.issue,
        $repo: input.repo,
        $title: input.title,
        $stage: input.stage,
        $status: input.status,
        $now: now,
      });
    return this.getRun(input.repo, input.issue)!;
  }

  updateRun(
    repo: string,
    issue: number,
    patch: Partial<
      Pick<
        Run,
        | "stage"
        | "status"
        | "tool_calls"
        | "tokens_in"
        | "tokens_out"
        | "cost_usd"
        | "gate_line"
        | "pr_url"
        | "reason"
        | "status_comment_id"
      >
    >,
  ): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = $${k}`).join(", ");
    const params: Record<string, unknown> = { $repo: repo, $issue: issue, $updated_at: new Date().toISOString() };
    for (const k of keys) params[`$${k}`] = (patch as Record<string, unknown>)[k];
    // The bound keys are dynamic (built from `patch`), so bun:sqlite's
    // per-call ParamsType inference can't type this statically; the values
    // are already constrained to Run's own field types above.
    this.db
      .query(`UPDATE runs SET ${set}, updated_at = $updated_at WHERE repo = $repo AND issue = $issue`)
      .run(params as unknown as SQLQueryBindings);
    // A run that stopped running gets its budget re-derived from the table if it resumes.
    if (patch.status !== undefined && patch.status !== "running") {
      const id = this.getRun(repo, issue)?.id;
      if (id !== undefined) this.budgets.delete(id);
    }
  }

  // How many runs hold an in-memory event budget; tests watch it for leaks.
  get openBudgets(): number {
    return this.budgets.size;
  }

  getRun(repo: string, issue: number): Run | undefined {
    return (
      (this.db.query("SELECT * FROM runs WHERE repo = $repo AND issue = $issue").get({ $repo: repo, $issue: issue }) as
        | Run
        | undefined) ?? undefined
    );
  }

  listRuns(repo?: string): Run[] {
    if (repo)
      return this.db
        .query("SELECT * FROM runs WHERE repo = $repo ORDER BY updated_at DESC")
        .all({ $repo: repo }) as Run[];
    return this.db.query("SELECT * FROM runs ORDER BY updated_at DESC").all() as Run[];
  }

  private readonly budgets = new Map<number, EventBudget>();
  // Per-run cap on stored event bytes (machinist events.go); tests lower it.
  eventByteLimit = MAX_EVENT_LOG_BYTES;

  appendEvent(runId: number, stage: Stage, kind: string, text: string): void {
    let budget = this.budgets.get(runId);
    if (!budget) {
      const row = this.db
        .query("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + LENGTH(kind)), 0) AS n FROM events WHERE run_id = $id")
        .get({ $id: runId }) as { n: number };
      budget = new EventBudget(row.n, this.eventByteLimit);
      this.budgets.set(runId, budget);
    }
    const verdict = budget.admit(Buffer.byteLength(text) + kind.length);
    if (verdict === "drop") return;
    if (verdict === "truncate") {
      kind = TRUNCATION_KIND;
      text = budget.message();
    }
    this.db
      .query("INSERT INTO events (run_id, ts, stage, kind, text) VALUES ($run_id, $ts, $stage, $kind, $text)")
      .run({ $run_id: runId, $ts: new Date().toISOString(), $stage: stage, $kind: kind, $text: text });
  }

  // Keyset pagination: pass the last id seen, get events after it.
  listEvents(runId: number, opts?: { after?: number; limit?: number }): RunEvent[] {
    const after = opts?.after ?? 0;
    const limit = opts?.limit ?? 200;
    return this.db
      .query("SELECT * FROM events WHERE run_id = $run_id AND id > $after ORDER BY id ASC LIMIT $limit")
      .all({ $run_id: runId, $after: after, $limit: limit }) as RunEvent[];
  }

  recordStageRun(input: StageRunInput): void {
    this.db
      .query(
        `INSERT INTO stage_runs (repo, issue, stage, agent, model, started_at, finished_at, duration_ms, tool_calls, tokens_in, tokens_out, tokens_cached, cost_usd, usage_complete, exit_code, killed_reason, session_id)
         VALUES ($repo, $issue, $stage, $agent, $model, $started_at, $finished_at, $duration_ms, $tool_calls, $tokens_in, $tokens_out, $tokens_cached, $cost_usd, $usage_complete, $exit_code, $killed_reason, $session_id)`,
      )
      .run({
        $repo: input.repo,
        $issue: input.issue,
        $stage: input.stage,
        $agent: input.agent,
        $model: input.model,
        $started_at: input.started_at,
        $finished_at: input.finished_at,
        $duration_ms: input.duration_ms,
        $tool_calls: input.tool_calls,
        $tokens_in: input.tokens_in,
        $tokens_out: input.tokens_out,
        $tokens_cached: input.tokens_cached ?? 0,
        $cost_usd: input.cost_usd,
        $usage_complete: input.usage_complete ?? 1,
        $exit_code: input.exit_code,
        $killed_reason: input.killed_reason,
        $session_id: input.session_id ?? null,
      });
  }

  // The verify row was recorded before its verdict.json was read; stamp the newest one.
  setVerifyVerdict(repo: string, issue: number, verdict: string): void {
    this.db
      .query(
        "UPDATE stage_runs SET verdict = $verdict WHERE id = (SELECT MAX(id) FROM stage_runs WHERE repo = $repo AND issue = $issue AND stage = 'verify')",
      )
      .run({ $repo: repo, $issue: issue, $verdict: verdict });
  }

  // The newest resumable session for an issue, for `factory takeover`, or of
  // one stage, for a rebuild that picks up where the last build left off.
  lastSession(
    repo: string,
    issue: number,
    stage?: Stage,
  ): (Pick<StageRun, "stage" | "agent"> & { session_id: string }) | undefined {
    return (this.db
      .query(
        "SELECT stage, agent, session_id FROM stage_runs WHERE repo = $repo AND issue = $issue AND session_id IS NOT NULL AND ($stage IS NULL OR stage = $stage) ORDER BY id DESC LIMIT 1",
      )
      .get({ $repo: repo, $issue: issue, $stage: stage ?? null }) ?? undefined) as
      | (Pick<StageRun, "stage" | "agent"> & { session_id: string })
      | undefined;
  }

  // Keyset pagination on id, like listEvents: pass the last id seen.
  listStageRuns(repo: string, opts?: { issue?: number; after?: number; limit?: number }): StageRun[] {
    const limit = opts?.limit ?? 200;
    const after = opts?.after ?? 0;
    if (opts?.issue !== undefined) {
      return this.db
        .query(
          "SELECT * FROM stage_runs WHERE repo = $repo AND issue = $issue AND id > $after ORDER BY id ASC LIMIT $limit",
        )
        .all({ $repo: repo, $issue: opts.issue, $after: after, $limit: limit }) as StageRun[];
    }
    return this.db
      .query("SELECT * FROM stage_runs WHERE repo = $repo AND id > $after ORDER BY id ASC LIMIT $limit")
      .all({ $repo: repo, $after: after, $limit: limit }) as StageRun[];
  }

  // Sum of known cost plus a count of runs whose cost is unknown (NULL, never
  // $0), since started_at, for this repo — or one issue in it when given.
  // `sinceIso` is the caller's window: the epoch for an issue's lifetime
  // spend, or 00:00 UTC today for the repo's daily spend (plan v2.7.0 item 7).
  spendSummary(repo: string, sinceIso: string, issue?: number): { costUsd: number; unreportedRuns: number } {
    const issueClause = issue !== undefined ? "AND issue = $issue" : "";
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS cost, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unreported
         FROM stage_runs WHERE repo = $repo AND started_at >= $since ${issueClause}`,
      )
      .get(
        issue !== undefined ? { $repo: repo, $since: sinceIso, $issue: issue } : { $repo: repo, $since: sinceIso },
      ) as { cost: number; unreported: number };
    return { costUsd: row.cost, unreportedRuns: row.unreported };
  }

  // Called first by all four retro triggers, even the three that then complete
  // the row within the same call: one queue, one status path, whether retro
  // runs immediately or (the dashboard's merge route) waits for the poll loop.
  queueRetro(repo: string, issue: number, outcome: RetroTrigger): number {
    this.db
      .query(
        "INSERT INTO retros (repo, issue, outcome, status, created_at) VALUES ($repo, $issue, $outcome, 'queued', $now)",
      )
      .run({ $repo: repo, $issue: issue, $outcome: outcome, $now: new Date().toISOString() });
    return (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  completeRetro(
    id: number,
    proposal?: { lesson?: string; skill_name?: string; skill_edit?: string },
    status: "done" | "failed" = "done",
  ): void {
    this.db
      .query(
        `UPDATE retros SET status = $status, lesson = $lesson, skill_name = $skill_name, skill_edit = $skill_edit, completed_at = $now WHERE id = $id`,
      )
      .run({
        $id: id,
        $status: status,
        $lesson: proposal?.lesson ?? null,
        $skill_name: proposal?.skill_name ?? null,
        $skill_edit: proposal?.skill_edit ?? null,
        $now: new Date().toISOString(),
      });
  }

  // Rows the dashboard's operator-merge route queued but nothing has run yet.
  listQueuedRetros(repo: string, limit = 50): RetroRow[] {
    return this.db
      .query("SELECT * FROM retros WHERE repo = $repo AND status = 'queued' ORDER BY id ASC LIMIT $limit")
      .all({ $repo: repo, $limit: limit }) as RetroRow[];
  }

  // Every retro for a repo regardless of status, newest first. `factory learn`
  // (plan v2.10.0 item 4) will filter this to done rows with a lesson.
  listRetros(repo: string, limit = 50): RetroRow[] {
    return this.db
      .query("SELECT * FROM retros WHERE repo = $repo ORDER BY id DESC LIMIT $limit")
      .all({ $repo: repo, $limit: limit }) as RetroRow[];
  }

  // Done rows with a proposal that `factory learn` (plan v2.10.0 item 4)
  // hasn't yet batched into a learning PR. Oldest first, so a batch applies
  // lessons in the order they were learned.
  pendingLessons(repo: string): RetroRow[] {
    return this.db
      .query(
        "SELECT * FROM retros WHERE repo = $repo AND status = 'done' AND learned_at IS NULL AND (lesson IS NOT NULL OR skill_name IS NOT NULL) ORDER BY id ASC",
      )
      .all({ $repo: repo }) as RetroRow[];
  }

  // Stamps the rows a learning PR just batched so a later run never re-batches them.
  markLearned(ids: readonly number[], when: string): void {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$id${i}`).join(", ");
    const params: Record<string, string | number> = { $when: when };
    ids.forEach((id, i) => {
      params[`$id${i}`] = id;
    });
    this.db.query(`UPDATE retros SET learned_at = $when WHERE id IN (${placeholders})`).run(params);
  }

  getToggle(key: string, fallback: boolean): boolean {
    const row = this.db.query("SELECT value FROM toggles WHERE key = $key").get({ $key: key }) as
      | { value: string }
      | undefined;
    if (!row) return fallback;
    return row.value === "1";
  }

  setToggle(key: string, value: boolean): void {
    this.db
      .query(
        "INSERT INTO toggles (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run({ $key: key, $value: value ? "1" : "0" });
  }

  // One row per GitHub delivery id; false when GitHub redelivered one already seen.
  recordDelivery(d: { id: string; event: string; action: string; repo: string }, at = new Date()): boolean {
    const r = this.db
      .query(
        "INSERT OR IGNORE INTO webhook_deliveries (delivery_id, event, action, repo, received_at) VALUES ($id, $event, $action, $repo, $at)",
      )
      .run({ $id: d.id, $event: d.event, $action: d.action, $repo: d.repo, $at: at.toISOString() });
    return r.changes > 0;
  }

  // The newest delivery's sequence number; the watcher polls early when it moves.
  latestDelivery(): number {
    const row = this.db.query("SELECT MAX(seq) AS seq FROM webhook_deliveries").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  // Event bus outbox. False when the id is already stored (an inbound redelivery).
  recordBusEvent(e: BusEventRow): boolean {
    const r = this.db
      .query(
        "INSERT OR IGNORE INTO bus_events (id, direction, type, source, subject, time, data, handled_at) VALUES ($id, $direction, $type, $source, $subject, $time, $data, $handled)",
      )
      .run({
        $id: e.id,
        $direction: e.direction,
        $type: e.type,
        $source: e.source,
        $subject: e.subject,
        $time: e.time,
        $data: e.data,
        $handled: e.handled_at,
      });
    return r.changes > 0;
  }

  busEvent(id: string): BusEventRow | undefined {
    return (
      (this.db.query("SELECT * FROM bus_events WHERE id = $id").get({ $id: id }) as BusEventRow | null) ?? undefined
    );
  }

  // Newest last; `after` is a seq for tailing.
  busEvents(limit = 50, after = 0): BusEventRow[] {
    return this.db
      .query(
        "SELECT * FROM (SELECT * FROM bus_events WHERE seq > $after ORDER BY seq DESC LIMIT $limit) ORDER BY seq ASC",
      )
      .all({
        $after: after,
        $limit: limit,
      }) as BusEventRow[];
  }

  // Inbound events the watcher has not handed to subscribers yet, oldest first.
  unhandledInbound(): BusEventRow[] {
    return this.db
      .query("SELECT * FROM bus_events WHERE direction = 'in' AND handled_at IS NULL ORDER BY seq ASC")
      .all() as BusEventRow[];
  }

  markBusHandled(id: string, at = new Date()): void {
    this.db.query("UPDATE bus_events SET handled_at = $at WHERE id = $id").run({ $id: id, $at: at.toISOString() });
  }

  queueBusDelivery(eventId: string, sink: string, at = new Date()): void {
    this.db
      .query("INSERT OR IGNORE INTO bus_deliveries (event_id, sink, status, next_at) VALUES ($e, $s, 'pending', $at)")
      .run({ $e: eventId, $s: sink, $at: at.toISOString() });
  }

  // Replay: put every delivery of one event back to pending, due now.
  requeueBusDeliveries(eventId: string, at = new Date()): number {
    return this.db
      .query(
        "UPDATE bus_deliveries SET status = 'pending', attempts = 0, next_at = $at, delivered_at = NULL, last_error = NULL WHERE event_id = $e",
      )
      .run({ $e: eventId, $at: at.toISOString() }).changes;
  }

  dueBusDeliveries(now = new Date()): BusDeliveryRow[] {
    return this.db
      .query("SELECT * FROM bus_deliveries WHERE status = 'pending' AND next_at <= $now ORDER BY id ASC")
      .all({ $now: now.toISOString() }) as BusDeliveryRow[];
  }

  busDeliveries(eventId: string): BusDeliveryRow[] {
    return this.db
      .query("SELECT * FROM bus_deliveries WHERE event_id = $e ORDER BY id ASC")
      .all({ $e: eventId }) as BusDeliveryRow[];
  }

  markBusDelivery(
    id: number,
    d: { status: "pending" | "delivered" | "dead"; attempts: number; nextAt: Date; error?: string },
    at = new Date(),
  ): void {
    this.db
      .query(
        "UPDATE bus_deliveries SET status = $status, attempts = $attempts, next_at = $next, last_error = $err, delivered_at = $delivered WHERE id = $id",
      )
      .run({
        $id: id,
        $status: d.status,
        $attempts: d.attempts,
        $next: d.nextAt.toISOString(),
        $err: d.error ?? null,
        $delivered: d.status === "delivered" ? at.toISOString() : null,
      });
  }

  // A free-form value in the same key table as the toggles (a cron trigger's last-checked minute).
  getSetting(key: string): string | undefined {
    const row = this.db.query("SELECT value FROM toggles WHERE key = $key").get({ $key: key }) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO toggles (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run({ $key: key, $value: value });
  }

  close(): void {
    this.db.close();
  }
}
