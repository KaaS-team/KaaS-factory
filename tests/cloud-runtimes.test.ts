import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCloudProvider } from "../src/cloud/claude";
import { cloudProvider } from "../src/cloud";
import { cursorLocalProvider } from "../src/cloud/cursor-local";
import { cloudLedger } from "../src/cloud/ledger";
import { spawnRun } from "../src/cloud/spawn";
import { statusLines } from "../src/cloud/status-cli";
import { mergeConfig } from "../src/config";
import { orchestrateOf } from "../src/orchestrate/config";
import { refillCloud, reserveForPoll } from "../src/orchestrate/refill";
import { FactoryState } from "../src/state";

const roots: string[] = [];
const scratch = () => {
  mkdirSync(tmpdir(), { recursive: true });
  const d = mkdtempSync(join(tmpdir(), "cloud-runtimes-"));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const store = () => {
  const m = new Map<string, string>();
  return { getSetting: (k: string) => m.get(k), setSetting: (k: string, v: string) => void m.set(k, v) };
};
const orchOf = (spec: Record<string, unknown>) =>
  orchestrateOf(mergeConfig({ repo: "a/b", orchestrate: spec } as never));
const issue = (number: number, labels: string[] = [], body = "") => ({ number, labels, body });

describe("refill reserves up to the free slots", () => {
  const orch = orchOf({ enabled: true, providers: { "cursor-cloud": { max: 2 } } });
  const pinned = (n: number) => issue(n, ["runtime:cursor-cloud"]);

  test("three labelled issues, two slots: two reservations", () => {
    const ledger = cloudLedger(store(), "a/b");
    const out = refillCloud({ ledger, orch, ready: [pinned(1), pinned(2), pinned(3)], spentTodayUsd: 0 });
    expect(out.reserved.map((r) => r.issue)).toEqual([1, 2]);
    expect(ledger.reservation(3)?.provider).toBe(undefined);
  });

  test("a later poll fills a slot that was freed", () => {
    const ledger = cloudLedger(store(), "a/b");
    refillCloud({ ledger, orch, ready: [pinned(1), pinned(2), pinned(3)], spentTodayUsd: 0 });
    ledger.release(1);
    const out = refillCloud({ ledger, orch, ready: [pinned(3)], spentTodayUsd: 0 });
    expect(out.reserved.map((r) => r.issue)).toEqual([3]);
  });

  test("the label picks the runtime over roles.build", () => {
    const localOnly = orchOf({ enabled: true, roles: { build: ["local"] } });
    const ready = [issue(1, ["runtime:cursor-cloud"]), issue(2, ["runtime:claude-cloud"])];
    const out = refillCloud({ ledger: cloudLedger(store(), "a/b"), orch: localOnly, ready, spentTodayUsd: 0 });
    expect(out.reserved).toEqual([{ issue: 1, provider: "cursor-cloud" }]);
  });

  test("an unlabelled issue with no planned files stays local", () => {
    const out = refillCloud({ ledger: cloudLedger(store(), "a/b"), orch, ready: [issue(1)], spentTodayUsd: 0 });
    expect(out.reserved).toEqual([]);
  });
});

describe("spend is reserved before launch", () => {
  const orch = orchOf({
    enabled: true,
    providers: { "cursor-cloud": { max: 5 } },
    cost: { perRunUsd: 5, perDayUsd: 12, intakeStopUsd: 10 },
  });
  const pinned = (n: number) => issue(n, ["runtime:cursor-cloud"]);

  test("each reservation holds the per-run amount", () => {
    const ledger = cloudLedger(store(), "a/b");
    refillCloud({ ledger, orch, ready: [pinned(1), pinned(2)], spentTodayUsd: 0 });
    expect(ledger.reservedUsd()).toBe(10);
  });

  test("a launch over the daily cap is refused and nothing is reserved", () => {
    const ledger = cloudLedger(store(), "a/b");
    const out = refillCloud({ ledger, orch, ready: [pinned(1), pinned(2), pinned(3)], spentTodayUsd: 0 });
    expect(out.reserved.map((r) => r.issue)).toEqual([1, 2]);
    expect(out.refused.map((r) => r.issue)).toEqual([3]);
    expect(out.refused[0]!.reason).toContain("over the $12 cap");
    expect(ledger.reservation(3)?.provider).toBe(undefined);
  });

  test("spend already recorded today counts against the cap", () => {
    const out = refillCloud({ ledger: cloudLedger(store(), "a/b"), orch, ready: [pinned(1)], spentTodayUsd: 8 });
    expect(out.reserved).toEqual([]);
    expect(out.refused).toHaveLength(1);
  });
});

describe("orchestrate.enabled", () => {
  test("a repo that sets it true turns orchestration on", () => {
    expect(orchOf({ enabled: true }).enabled).toBe(true);
  });
  test("unset, it stays off", () => {
    expect(orchOf({}).enabled).toBe(false);
  });
});

describe("polling with orchestration off is unchanged", () => {
  test("reserveForPoll reserves nothing", async () => {
    const state = new FactoryState(":memory:");
    const config = mergeConfig({ repo: "a/b" });
    const ready = [{ number: 1, body: "", labels: [{ name: "runtime:cursor-cloud" }] }];
    expect((await reserveForPoll({ state }, config, ready))?.reserved).toBe(undefined);
    expect(cloudLedger(state, "a/b").reservation(1)?.provider).toBe(undefined);
    state.close();
  });
});

describe("factory cloud status", () => {
  test("lists each reservation and session", () => {
    const ledger = cloudLedger(store(), "a/b");
    ledger.reserve(4, "cursor-cloud", 5);
    ledger.reserve(9, "claude-cloud");
    ledger.started(9, "claude-cloud", "sess-9", "sha");
    const text = statusLines(ledger.all()).join("\n");
    expect(text).toContain("#4 reserved cursor-cloud attempt 1 $5");
    expect(text).toContain("#9 running claude-cloud session sess-9");
  });
});

describe("claude-cloud spawns its command", () => {
  test("the default runner runs the configured argv", async () => {
    const dir = scratch();
    const bin = join(dir, "fake-claude-cloud");
    writeFileSync(bin, '#!/bin/sh\necho \'{"id":"sess-7"}\'\n');
    chmodSync(bin, 0o755);
    const p = cloudProvider("claude-cloud", { providers: { "claude-cloud": { launch: [bin, "{branch}"] } } } as never, {
      secrets: { get: () => undefined },
    })!;
    const run = await p.launch({
      repoUrl: "u",
      branch: "b",
      prompt: "p",
      model: "m",
      key: "k",
      title: "t",
      issueRef: "a/b#1",
    });
    expect(run.id).toBe("sess-7");
  });

  test("spawnRun reports a failing command's exit code", async () => {
    expect((await spawnRun(["sh", "-c", "exit 3"])).code).toBe(3);
  });

  test("a provider built without a runner no longer fails every launch", () => {
    const p = claudeCloudProvider({ launch: ["x"], status: [], cancel: [] });
    expect(p.name).toBe("claude-cloud");
  });
});

describe("cursor-local drives the local agent and pushes", () => {
  const git = async (cwd: string, ...args: string[]) => {
    const r = await spawnRun(["git", ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return r.stdout.trim();
  };

  async function setup() {
    const root = scratch();
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    mkdirSync(work);
    await git(root, "init", "--bare", "-b", "main", remote);
    await git(work, "init", "-b", "main");
    await git(work, "config", "user.email", "t@example.com");
    await git(work, "config", "user.name", "t");
    await git(work, "remote", "add", "origin", remote);
    writeFileSync(join(work, "README"), "x");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "init");
    await git(work, "push", "origin", "main");
    await git(work, "checkout", "-b", "factory/issue-5");
    const agent = join(root, "fake-cursor-agent");
    writeFileSync(
      agent,
      `#!/bin/sh\ncat > "${join(root, "stdin.txt")}"\necho built > feature.txt\ngit add feature.txt\ngit commit -q -m "build"\n`,
    );
    chmodSync(agent, 0o755);
    return { root, remote, work, agent };
  }
  const input = (cwd: string, agentPushes = false) => ({
    repoUrl: "u",
    branch: "factory/issue-5",
    prompt: "read the issue",
    model: "auto",
    key: "k",
    title: "t",
    issueRef: "a/b#5",
    cwd,
    agentPushes,
  });
  const settle = async (p: ReturnType<typeof cursorLocalProvider>, id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = await p.poll(id);
      if (r.status !== "running") return r;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("never settled");
  };

  test("the fake agent builds, the runner side pushes, and the remote holds the commit", async () => {
    const { root, remote, work, agent } = await setup();
    const p = cursorLocalProvider({ launch: [agent], run: spawnRun });
    const { id } = await p.launch(input(work));
    expect((await settle(p, id)).status).toBe("finished");
    expect(await git(remote, "log", "-1", "--format=%s", "factory/issue-5")).toBe("build");
    expect(readFileSync(join(root, "stdin.txt"), "utf8")).toBe("read the issue");
  });

  test("with the agent pushing, the provider does not push", async () => {
    const { remote, work, agent } = await setup();
    const p = cursorLocalProvider({ launch: [agent], run: spawnRun });
    const { id } = await p.launch(input(work, true));
    expect((await settle(p, id)).status).toBe("finished");
    const heads = await spawnRun(["git", "branch", "--list", "factory/issue-5"], { cwd: remote });
    expect(heads.stdout.trim()).toBe("");
  });

  test("a failing agent is an error and pushes nothing", async () => {
    const { remote, work, root } = await setup();
    const bad = join(root, "bad-agent");
    writeFileSync(bad, "#!/bin/sh\nexit 1\n");
    chmodSync(bad, 0o755);
    const p = cursorLocalProvider({ launch: [bad], run: spawnRun });
    const { id } = await p.launch(input(work));
    expect((await settle(p, id)).status).toBe("error");
    expect((await spawnRun(["git", "branch", "--list", "factory/issue-5"], { cwd: remote })).stdout.trim()).toBe("");
  });
});
