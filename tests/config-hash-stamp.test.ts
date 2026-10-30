import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { FactoryState, type StageRunInput } from "../src/state";

const SRC = join(import.meta.dir, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

test("every upsertRun and recordStageRun call in src passes config_hash", () => {
  const missing: string[] = [];
  let found = 0;
  for (const file of files(SRC)) {
    if (file === join(SRC, "state.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\.(upsertRun|recordStageRun)\(\{/g)) {
      found++;
      const call = text.slice(m.index, text.indexOf("});", m.index));
      if (!call.includes("config_hash:")) {
        const line = text.slice(0, m.index).split("\n").length;
        missing.push(`${relative(SRC, file)}:${line}`);
      }
    }
  }
  expect(found).toBeGreaterThanOrEqual(4);
  expect(missing).toEqual([]);
});

const stage = (over: Partial<StageRunInput> = {}): StageRunInput => ({
  repo: "a/b",
  issue: 1,
  stage: "build",
  agent: "claude",
  model: null,
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:01:00Z",
  duration_ms: 60000,
  tool_calls: 1,
  tokens_in: 1,
  tokens_out: 1,
  cost_usd: 0.1,
  exit_code: 0,
  killed_reason: null,
  ...over,
});

test("both tables store the hash", () => {
  const state = new FactoryState(":memory:");
  state.upsertRun({
    issue: 1,
    repo: "a/b",
    title: "t",
    stage: "build",
    status: "running",
    config_hash: "abc123def456",
  });
  expect(state.getRun("a/b", 1)?.config_hash).toBe("abc123def456");
  state.recordStageRun(stage({ config_hash: "abc123def456" }));
  state.recordStageRun(stage());
  const rows = state.listStageRuns("a/b");
  expect(rows.map((r) => r.config_hash).sort()).toEqual(["abc123def456", null]);
  state.close();
});

test("an old database gains the column, keeps its rows, and reopens", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hash-stamp-")), "state.db");
  const old = new Database(path);
  old.exec(`
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue INTEGER NOT NULL, repo TEXT NOT NULL, title TEXT NOT NULL,
      stage TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      tool_calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, gate_line TEXT, pr_url TEXT, reason TEXT, status_comment_id INTEGER,
      UNIQUE(repo, issue)
    );
    CREATE TABLE stage_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, issue INTEGER NOT NULL, stage TEXT NOT NULL,
      agent TEXT NOT NULL, model TEXT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
      tool_calls INTEGER NOT NULL DEFAULT 0, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, exit_code INTEGER NOT NULL, killed_reason TEXT
    );
    INSERT INTO runs (issue, repo, title, stage, status, started_at, updated_at)
      VALUES (1, 'a/b', 'old', 'build', 'running', 'x', 'x');
    INSERT INTO stage_runs (repo, issue, stage, agent, started_at, finished_at, duration_ms, exit_code)
      VALUES ('a/b', 1, 'build', 'claude', 'x', 'x', 5, 0);
  `);
  old.close();
  for (let i = 0; i < 2; i++) {
    new FactoryState(path).close();
    const db = new Database(path, { readonly: true });
    for (const table of ["runs", "stage_runs"]) {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("config_hash");
      expect((db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
    }
    db.close();
  }
});
