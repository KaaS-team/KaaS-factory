// `factory learn --export`: the state rows as v1 JSONL, with no learning PR opened.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportLearning } from "../src/learn-export";
import { FactoryState, type StageRunInput } from "../src/state";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "factory-learn-export-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const repo = "acme/widgets";

function stage(r: string, issue: number, startedAt = "2026-09-01T00:00:00.000Z"): StageRunInput {
  return {
    repo: r,
    issue,
    stage: "build",
    agent: "claude",
    model: null,
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 1,
    tool_calls: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: null,
    exit_code: 0,
    killed_reason: null,
  };
}

function parse(state: FactoryState, since?: string) {
  return [...exportLearning(state, repo, since)].map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("exportLearning", () => {
  test("yields v:1 run, stage and retro lines for the repo only", () => {
    const state = new FactoryState(":memory:");
    state.upsertRun({ issue: 1, repo, title: "t", stage: "build", status: "running" });
    state.upsertRun({ issue: 2, repo: "other/repo", title: "t", stage: "build", status: "running" });
    state.recordStageRun(stage(repo, 1));
    state.recordStageRun(stage("other/repo", 2));
    state.queueRetro(repo, 1, "merged");
    state.queueRetro("other/repo", 2, "merged");

    const lines = [...exportLearning(state, repo)];
    for (const l of lines) expect(l).not.toContain("\n");
    const rows = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.map((r) => r.type).sort()).toEqual(["retro", "run", "stage"]);
    for (const r of rows) {
      expect(r.v).toBe(1);
      expect(r.repo).toBe(repo);
    }
    expect(rows.find((r) => r.type === "run")).toEqual({ v: 1, type: "run", ...state.listRuns(repo)[0]! });
    expect(rows.find((r) => r.type === "stage")).toEqual({
      v: 1,
      type: "stage",
      ...state.listStageRuns(repo)[0]!,
    });
    expect(rows.find((r) => r.type === "retro")).toEqual({ v: 1, type: "retro", ...state.listRetros(repo)[0]! });
  });

  test("pages past 200 stage rows and 50 retros", () => {
    const state = new FactoryState(":memory:");
    for (let i = 0; i < 205; i++) state.recordStageRun(stage(repo, i));
    for (let i = 0; i < 55; i++) state.queueRetro(repo, i, "merged");
    const rows = parse(state);
    expect(rows.filter((r) => r.type === "stage")).toHaveLength(205);
    expect(rows.filter((r) => r.type === "retro")).toHaveLength(55);
  });

  test("--since drops rows older than the date and keeps rows at it", () => {
    const state = new FactoryState(":memory:");
    const old = "2026-01-01T00:00:00.000Z";
    const edge = "2026-06-01T00:00:00.000Z";
    state.upsertRun({ issue: 1, repo, title: "old", stage: "build", status: "running" });
    state.upsertRun({ issue: 2, repo, title: "edge", stage: "build", status: "running" });
    state.recordStageRun(stage(repo, 1, old));
    state.recordStageRun(stage(repo, 2, edge));
    state.queueRetro(repo, 1, "merged");
    state.queueRetro(repo, 2, "merged");
    state.write((db) => {
      db.query("UPDATE runs SET started_at = $t WHERE issue = 1").run({ $t: old });
      db.query("UPDATE runs SET started_at = $t WHERE issue = 2").run({ $t: edge });
      db.query("UPDATE retros SET created_at = $t WHERE issue = 1").run({ $t: old });
      db.query("UPDATE retros SET created_at = $t WHERE issue = 2").run({ $t: edge });
    });
    const rows = parse(state, edge);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.issue).toBe(2);
  });
});

async function factory(...args: string[]) {
  const proc = Bun.spawn(["bun", cli, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function fixture() {
  const repoDir = mkdtempSync(join(dir, "r-"));
  mkdirSync(join(repoDir, ".factory"));
  writeFileSync(join(repoDir, ".factory/config.json"), JSON.stringify({ repo }));
  const db = join(repoDir, "state.db");
  const state = new FactoryState(db);
  state.upsertRun({ issue: 1, repo, title: "t", stage: "build", status: "running" });
  state.recordStageRun(stage(repo, 1));
  state.queueRetro(repo, 1, "merged");
  state.close();
  return { repoDir, db };
}

describe("factory learn --export", () => {
  test("learn --export <file> and --export - write the lines without running runLearn", async () => {
    const { repoDir, db } = fixture();
    const file = join(repoDir, "out.jsonl");
    const base = ["learn", "--repo-dir", repoDir, "--db", db];

    const toFile = await factory(...base, "--export", file);
    expect(toFile.code).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l).type)
        .sort(),
    ).toEqual(["retro", "run", "stage"]);

    const toStdout = await factory(...base, "--export", "-");
    expect(toStdout.code).toBe(0);
    expect(toStdout.out).toBe(text);
    expect(existsSync(join(repoDir, ".git"))).toBe(false);
  });

  test("learn --export with an invalid --since exits non-zero", async () => {
    const { repoDir, db } = fixture();
    const r = await factory("learn", "--repo-dir", repoDir, "--db", db, "--export", "-", "--since", "not-a-date");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--since");
    expect(r.out).toBe("");
  });
});
