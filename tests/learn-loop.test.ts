// The learning loop: a daily lessons PR from the watcher, one export across the registry, a sink that can fail.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { defaultStatePath } from "../src/paths";
import { runLearn, runLearnDaily } from "../src/learn";
import { exportAll, runExportAll } from "../src/learn-export";
import { FactoryState } from "../src/state";
import { pollOnce } from "../src/watch";
import { baseIssue, FakeGateRunner, FakeGit, FakeGitHub, FakeHoldoutRunner } from "./harness";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "factory-learn-loop-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = "acme/widgets";
const DAY1 = new Date("2026-10-01T09:00:00Z");
const DAY1_LATER = new Date("2026-10-01T18:00:00Z");
const DAY2 = new Date("2026-10-02T09:00:00Z");

function setup() {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(root, "ws-"));
  const git = new FakeGit();
  git.changed = [".factory/memory/lessons.md"];
  const github = new FakeGitHub([]);
  const state = new FactoryState(":memory:");
  const deps = { github, git, state, cloneDir: dir, workspacesDir: dir };
  const lesson = (issue: number, text: string) => {
    const id = state.queueRetro(repo, issue, "merged");
    state.completeRetro(id, { lesson: text });
  };
  return { deps, git, github, state, lesson };
}

describe("daily learn", () => {
  test("opens one PR a day and leaves a later lesson the same day for tomorrow", async () => {
    const { deps, github, lesson } = setup();
    lesson(1, "first");
    await runLearnDaily(deps, repo, "main", DAY1);
    expect(github.createdPrs).toHaveLength(1);

    lesson(2, "second");
    await runLearnDaily(deps, repo, "main", DAY1_LATER);
    expect(github.createdPrs).toHaveLength(1);

    await runLearnDaily(deps, repo, "main", DAY2);
    expect(github.createdPrs).toHaveLength(2);
  });

  test("a failed attempt does not throw and retries on the next call", async () => {
    const { deps, git, github, lesson } = setup();
    lesson(1, "first");
    git.changed = ["src/outside.ts"];
    await runLearnDaily(deps, repo, "main", DAY1);
    expect(github.createdPrs).toHaveLength(0);

    git.changed = [".factory/memory/lessons.md"];
    await runLearnDaily(deps, repo, "main", DAY1);
    expect(github.createdPrs).toHaveLength(1);
  });

  test("a poll runs it by itself and a failing attempt does not stop intake", async () => {
    const { deps, git, state, lesson } = setup();
    lesson(1, "first");
    git.changed = ["src/outside.ts"];
    const github = new FakeGitHub([baseIssue(9, ["factory:ready"])]);
    const starts: number[] = [];
    const full = {
      ...deps,
      github,
      executor: {
        runStage: (o: { issue: number }) => {
          starts.push(o.issue);
          return Promise.reject(new Error("no stage"));
        },
      },
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      now: () => DAY1,
    };
    const config = mergeConfig({ repo, concurrency: 1 });
    await pollOnce(full as never, config).catch(() => undefined);
    expect(github.createdPrs).toHaveLength(0);
    expect(starts).toContain(9);

    git.changed = [".factory/memory/lessons.md"];
    await pollOnce(full as never, config).catch(() => undefined);
    expect(github.createdPrs).toHaveLength(1);
    expect(state.pendingLessons(repo)).toEqual([]);
  });

  test("a sink that throws does not fail the run", async () => {
    const { deps, lesson } = setup();
    lesson(1, "first");
    const sink = { push: () => Promise.reject(new Error("brain down")) };
    const r = await runLearn({ ...deps, sink }, repo, "main", DAY1);
    expect(r.batched).toBe(1);
  });
});

describe("learn --export --all", () => {
  function seed(name: string, issue: number): string {
    const path = join(root, `${name}.db`);
    const state = new FactoryState(path);
    state.upsertRun({ issue, repo: name, title: "t", stage: "build", status: "running" });
    state.close();
    return path;
  }

  test("one JSONL across every repo, skipping a repo with no database and creating none", () => {
    const a = seed("acme/a", 1);
    const b = seed("acme/b", 2);
    const missing = join(root, "missing.db");
    const paths: Record<string, string> = { "acme/a": a, "acme/b": b, "acme/c": missing };
    const lines = exportAll(Object.keys(paths), (r) => paths[r]!);
    expect(lines.map((l) => JSON.parse(l).repo)).toEqual(["acme/a", "acme/b"]);
    expect(() => statSync(missing)).toThrow();
  });

  test("it only reads: the database files are byte-identical afterwards", () => {
    const a = seed("acme/d", 1);
    const before = readFileSync(a);
    const out = join(root, "out.jsonl");
    runExportAll(["acme/d"], () => a, out, undefined);
    expect(readFileSync(a).equals(before)).toBe(true);
    expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("a stale schema is not migrated", () => {
    const path = join(root, "old.db");
    writeFileSync(path, "");
    expect(() => exportAll(["acme/old"], () => path)).toThrow();
    expect(statSync(path).size).toBe(0);
  });
});

describe("factory learn --export --all (cli)", () => {
  test("reads the registry in machine.json and writes one JSONL", () => {
    const home = mkdtempSync(join(root, "home-"));
    for (const [r, issue] of [
      ["acme/a", 1],
      ["acme/b", 2],
    ] as const) {
      const state = new FactoryState(defaultStatePath({ FACTORY_HOME: home }, r));
      state.upsertRun({ issue, repo: r, title: "t", stage: "build", status: "running" });
      state.close();
    }
    writeFileSync(
      join(home, "machine.json"),
      JSON.stringify({
        slots: 1,
        repos: [{ repo: "acme/a" }, { repo: "acme/b" }, { repo: "acme/off", enabled: false }],
      }),
    );
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "learn", "--export", "-", "--all"], {
      env: { ...process.env, FACTORY_HOME: home },
      timeout: 30_000,
    });
    expect(p.exitCode).toBe(0);
    const repos = p.stdout
      .toString()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).repo);
    expect(repos).toEqual(["acme/a", "acme/b"]);
  });
});
