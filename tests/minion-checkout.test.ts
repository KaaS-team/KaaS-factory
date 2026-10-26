// A minion with `checkout: true` runs in a fresh clone of the repo, so it can read the code;
// without it the workspace starts empty, as before.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMinion } from "../src/core/minion";
import { EventBus } from "../src/engine/bus";
import { runMinion } from "../src/engine/minion";
import { mergeConfig } from "../src/config";
import { FactoryState } from "../src/state";
import type { StageRunOptions, StageRunResult } from "../src/ports/agent";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });

function repo(): string {
  const d = tmp("minion-repo-");
  git(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "README.md"), "the code\n");
  git(d, "add", ".");
  git(d, "commit", "-qm", "init");
  return d;
}

// Reads what the workspace holds at run time, the way an agent would.
class ReadingAgent {
  saw: (string | null)[] = [];
  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    const f = join(opts.cwd, "README.md");
    this.saw.push(existsSync(f) ? readFileSync(f, "utf8") : null);
    writeFileSync(join(opts.cwd, "scratch.txt"), "left behind");
    return {
      events: [],
      toolCalls: 1,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      exitCode: 0,
      permissionDenials: [],
      finalMessage: '```json\n{"ok":true}\n```',
      agent: "claude",
    };
  }
}

function deps(agent: ReadingAgent, cloneDir: string) {
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/o/r", autoDeliver: false, log: () => {} });
  return { executor: agent, state, bus, cloneDir, workspacesDir: tmp("minion-ws-") } as never;
}

const minion = (extra: Record<string, unknown>) => {
  const r = parseMinion({
    name: "reader",
    description: "d",
    on: { event: "tasks.task.updated" },
    prompt: "p",
    ...extra,
  });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.minion;
};

describe("minion checkout", () => {
  test("a checkout minion runs in a fresh clone of the repo each time; without it the workspace is empty", async () => {
    const config = mergeConfig({ repo: "o/r" });
    const src = repo();
    const reader = new ReadingAgent();
    const d = deps(reader, src);
    expect((await runMinion(d, config, minion({ checkout: true }))).status).toBe("ok");
    expect((await runMinion(d, config, minion({ checkout: true }))).status).toBe("ok");
    expect(reader.saw).toEqual(["the code\n", "the code\n"]);
    const ws = join((d as { workspacesDir: string }).workspacesDir, "minion-reader");
    expect(existsSync(join(ws, ".git"))).toBe(true);

    const empty = new ReadingAgent();
    expect((await runMinion(deps(empty, src), config, minion({}))).status).toBe("ok");
    expect(empty.saw).toEqual([null]);
  });

  test("checkout must be a boolean, and a clone that fails is a failed run", async () => {
    const bad = parseMinion({
      name: "r",
      description: "d",
      on: { event: "tasks.task.updated" },
      prompt: "p",
      checkout: "yes",
    });
    expect(bad.ok ? [] : bad.problems).toContain("checkout: true or false");
    const run = await runMinion(
      deps(new ReadingAgent(), tmp("not-a-repo-")),
      mergeConfig({ repo: "o/r" }),
      minion({ checkout: true }),
    );
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("minion checkout failed");
  });
});
