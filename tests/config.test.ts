import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  configProblems,
  DEFAULT_CONFIG,
  gateCount,
  holdoutEnabled,
  loadConfig,
  TRACKER_KINDS,
  type TrackerConfig,
  testGate,
} from "../src/config";
import { makeTracker } from "../src/scm";
import { hasNoGates } from "../src/gates";
import { isFilledIn } from "../src/init";

const dir = mkdtempSync(join(tmpdir(), "factory-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function repoWith(config?: object): string {
  const d = mkdtempSync(join(dir, "r-"));
  if (config) {
    mkdirSync(join(d, ".factory"));
    writeFileSync(join(d, ".factory/config.json"), JSON.stringify(config));
  }
  return d;
}

describe("loadConfig", () => {
  test("refuses to start without a config file, and says how to fix it", async () => {
    await expect(loadConfig(repoWith())).rejects.toThrow(/factory install/);
  });

  test("refuses an empty or malformed repo", async () => {
    await expect(loadConfig(repoWith({}))).rejects.toThrow(/owner\/name/);
    await expect(loadConfig(repoWith({ repo: "just-a-name" }))).rejects.toThrow(/owner\/name/);
  });

  test("fills defaults around a minimal config", async () => {
    const c = await loadConfig(repoWith({ repo: "acme/widgets", agentCommands: { build: ["make *"] } }));
    expect(c.agentCommands).toEqual({ read: [], build: ["make *"], verify: [] });
    expect(c.base).toBe("main");
  });
});

// A config generated for a repo whose default branch is not "main" must not
// silently point PRs and reset at a branch that does not exist (plan v2.6.2
// item 3). Local `--repo-dir` mode has no `ensureRepoClone` (VM/CI-only) to
// resolve this, so loadConfig has to do it itself.
describe('base branch defaults to origin/HEAD, not the hard-coded "main"', () => {
  function git(cwd: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }

  function cloneOfTrunkRepo(): string {
    const src = mkdtempSync(join(dir, "src-"));
    git(src, "init", "-q", "-b", "trunk");
    writeFileSync(join(src, "f.txt"), "x");
    git(src, "add", ".");
    git(src, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-m", "x");
    const bare = `${mkdtempSync(join(dir, "bare-"))}.git`;
    git(dir, "clone", "-q", "--bare", src, bare);
    const wd = join(dir, `wd-${Math.random().toString(36).slice(2)}`);
    git(dir, "clone", "-q", bare, wd);
    return wd;
  }

  test("a config that omits base picks up origin/HEAD's branch", async () => {
    const wd = cloneOfTrunkRepo();
    mkdirSync(join(wd, ".factory"));
    writeFileSync(join(wd, ".factory/config.json"), JSON.stringify({ repo: "acme/x", gates: [] }));
    const c = await loadConfig(wd);
    expect(c.base).toBe("trunk");
  });

  test('a config that names base explicitly, even "main", is never overridden', async () => {
    const wd = cloneOfTrunkRepo();
    mkdirSync(join(wd, ".factory"));
    writeFileSync(join(wd, ".factory/config.json"), JSON.stringify({ repo: "acme/x", base: "main", gates: [] }));
    const c = await loadConfig(wd);
    expect(c.base).toBe("main");
  });
});

describe("holdoutEnabled", () => {
  test("off when cmd is empty, on otherwise, regardless of paths", () => {
    expect(holdoutEnabled({ paths: [], cmd: "" })).toBe(false);
    expect(holdoutEnabled({ paths: [".factory/holdout/**"], cmd: "" })).toBe(false);
    expect(holdoutEnabled({ paths: [], cmd: "bun test .factory/holdout" })).toBe(true);
  });
});

describe("config validation at boot", () => {
  test("an unknown top-level key refuses to start and names the key", async () => {
    await expect(loadConfig(repoWith({ repo: "a/b", maxOpenFactoryPr: 3 }))).rejects.toThrow(
      /maxOpenFactoryPr: unknown key/,
    );
  });

  test("a test gate's fileCmd is a string, and a typo of it is an unknown key", () => {
    expect(
      configProblems({
        repo: "a/b",
        gates: [{ name: "check", cmd: "make check", fileCmd: "bun test", required: true, role: "test" }],
      }),
    ).toEqual([]);
    expect(
      configProblems({
        repo: "a/b",
        gates: [{ name: "check", cmd: "make check", fileCmd: 1, required: true, role: "test" }],
      }),
    ).toEqual([expect.stringContaining("gates[0].fileCmd")]);
    expect(
      configProblems({
        repo: "a/b",
        gates: [{ name: "check", cmd: "make check", filecmd: "bun test", required: true }],
      }),
    ).toEqual([expect.stringContaining("gates[0].filecmd: unknown key")]);
  });

  test("a wrong type is refused, and every problem is listed at once", () => {
    const problems = configProblems({
      repo: "a/b",
      concurrency: "3",
      riskPolicy: { autoApproveLowRisk: "yes" },
      maxBudgetUsd: { build: 0, bulid: 1 },
      gates: [{ name: "t", cmd: "x", required: 1 }],
    });
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toMatch(/concurrency: expected posInt/);
    expect(problems.join("\n")).toMatch(/riskPolicy\.autoApproveLowRisk: expected boolean/);
    expect(problems.join("\n")).toMatch(/maxBudgetUsd\.build: expected positive/);
    expect(problems.join("\n")).toMatch(/maxBudgetUsd\.bulid: unknown key/);
    expect(problems.join("\n")).toMatch(/gates\[0\]\.required: expected boolean/);
  });

  test("postEditCommand must be an argv list, so the hook never gets a shell string", () => {
    expect(configProblems({ repo: "a/b", postEditCommand: ["biome", "check", "{file}"] })).toEqual([]);
    expect(configProblems({ repo: "a/b", postEditCommand: "biome check {file}" })).toEqual([
      'postEditCommand: expected strings, got "biome check {file}"',
    ]);
  });

  test("tracker defaults to GitHub; http needs an https url and a token env var name", () => {
    expect(DEFAULT_CONFIG.tracker).toEqual({ kind: "github" });
    expect(configProblems({ repo: "a/b", tracker: { kind: "github" } })).toEqual([]);
    expect(
      configProblems({
        repo: "a/b",
        tracker: { kind: "http", url: "https://tasks.example.com", tokenEnv: "TASKS_TOKEN", project: "web" },
      }),
    ).toEqual([]);
    expect(
      configProblems({ repo: "a/b", tracker: { kind: "http", url: "http://127.0.0.1:9000", tokenEnv: "T" } }),
    ).toEqual([]);
    expect(configProblems({ repo: "a/b", tracker: { kind: "trello" } })).toEqual([
      'tracker.kind: expected one of "github", "http", "linear", "plane", "jira", "clickup", "asana", got "trello"',
    ]);
    expect(configProblems({ repo: "a/b", tracker: { kind: "toString" } })).toEqual([
      expect.stringContaining("tracker.kind: expected one of"),
    ]);
    expect(configProblems({ repo: "a/b", tracker: { kind: "github", url: "https://x" } })).toEqual([
      expect.stringContaining("tracker.url: unknown key"),
    ]);
    expect(
      configProblems({
        repo: "a/b",
        tracker: { kind: "http", url: "http://tasks.example.com", tokenEnv: "sk-live-abc" },
      }),
    ).toEqual([
      'tracker.url: https (plain http only to localhost), got "http://tasks.example.com"',
      'tracker.tokenEnv: expected an env var name, got "sk-live-abc"',
    ]);
    expect(configProblems({ repo: "a/b", tracker: { kind: "http" } })).toEqual([
      "tracker.url: required",
      "tracker.tokenEnv: required (the name of the env var holding the token)",
    ]);
  });

  test("each native tracker kind validates its own keys, and makeTracker builds every kind", () => {
    const ok: TrackerConfig[] = [
      { kind: "linear", team: "ENG", tokenEnv: "LINEAR_API_KEY" },
      { kind: "plane", workspace: "acme", project: "p1", tokenEnv: "PLANE_API_KEY", url: "https://plane.acme.dev" },
      { kind: "jira", url: "https://acme.atlassian.net", project: "SHOP", tokenEnv: "JIRA_TOKEN", issueType: "Bug" },
      { kind: "clickup", workspace: "9001", list: "901", tokenEnv: "CLICKUP_API_TOKEN", labelTrust: "creator" },
      { kind: "asana", workspace: "1200", project: "1201", tokenEnv: "ASANA_TOKEN" },
    ];
    for (const tracker of ok) expect(configProblems({ repo: "a/b", tracker })).toEqual([]);
    expect(new Set([...ok.map((t) => t.kind), "github", "http"])).toEqual(new Set(TRACKER_KINDS));
    for (const tracker of [...ok, { kind: "github" } as const])
      expect(makeTracker(tracker, {}).constructor.name.toLowerCase()).toContain(
        tracker.kind === "github" ? "github" : tracker.kind,
      );
    expect(configProblems({ repo: "a/b", tracker: { kind: "jira", project: "SHOP" } })).toEqual([
      "tracker.url: required",
      "tracker.tokenEnv: required (the name of the env var holding the token)",
    ]);
    expect(
      configProblems({
        repo: "a/b",
        tracker: { kind: "linear", team: "ENG", tokenEnv: "K", url: "http://linear.example" },
      }),
    ).toEqual(['tracker.url: https (plain http only to localhost), got "http://linear.example"']);
    expect(
      configProblems({
        repo: "a/b",
        tracker: { kind: "clickup", workspace: "1", list: "2", tokenEnv: "K", labelTrust: "all" },
      }),
    ).toEqual(['tracker.labelTrust: expected "none" or "creator", got "all"']);
    expect(
      configProblems({
        repo: "a/b",
        tracker: { kind: "asana", workspace: "1", project: "2", tokenEnv: "K", team: "x" },
      }),
    ).toEqual([expect.stringContaining("tracker.team: unknown key")]);
  });

  test("labels maps factory labels to a team's names, one to one", () => {
    expect(configProblems({ repo: "a/b", labels: { "factory:ready": "ready-for-ai", _note: "x" } })).toEqual([]);
    expect(configProblems({ repo: "a/b", labels: { "factory:ready": "ai", "factory:failed": "ai" } })).toEqual([
      'labels.factory:failed: "ai" is already the name for factory:ready',
    ]);
    expect(configProblems({ repo: "a/b", labels: { "factory:ready": "factory:failed" } })).toEqual([
      'labels.factory:ready: "factory:failed" is itself a factory label name',
    ]);
    expect(configProblems({ repo: "a/b", labels: { "factory:ready": "" } })).toEqual([
      'labels.factory:ready: expected a label name, got ""',
    ]);
  });

  test("agent-facing riskCriteria and _comment keys are allowed", () => {
    expect(configProblems({ repo: "a/b", _comment: "hi", riskCriteria: { low: {} } })).toEqual([]);
  });

  // Plan v2.11.0 item C: holdout is off by default (empty cmd), so "" must
  // pass even though every other "string"-kind key requires non-empty.
  test("holdout.cmd may be empty (the off switch), but not the wrong type", () => {
    expect(configProblems({ repo: "a/b", holdout: { paths: [], cmd: "" } })).toEqual([]);
    const problems = configProblems({ repo: "a/b", holdout: { cmd: 1, paths: "nope", extra: true } });
    expect(problems.join("\n")).toMatch(/holdout\.cmd: expected string/);
    expect(problems.join("\n")).toMatch(/holdout\.paths: expected strings/);
    expect(problems.join("\n")).toMatch(/holdout\.extra: unknown key/);
  });

  test("tmux, prRunSummary and templateOverrides are accepted, and wrong types are named", () => {
    expect(
      configProblems({
        repo: "a/b",
        tmux: { enabled: true, session: "demo" },
        prRunSummary: false,
        templateOverrides: [".claude/skills/x/"],
      }),
    ).toEqual([]);
    const problems = configProblems({
      repo: "a/b",
      tmux: { enabled: "yes", window: 1 },
      prRunSummary: "no",
      templateOverrides: "x",
    }).join("\n");
    expect(problems).toMatch(/tmux\.enabled: expected boolean/);
    expect(problems).toMatch(/tmux\.window: unknown key/);
    expect(problems).toMatch(/prRunSummary: expected boolean/);
    expect(problems).toMatch(/templateOverrides: expected strings/);
  });

  test("every key of DEFAULT_CONFIG validates, and the shipped example config passes", () => {
    expect(configProblems({ ...DEFAULT_CONFIG, repo: "a/b" })).toEqual([]);
    const example = JSON.parse(readFileSync(join(import.meta.dir, "../template/.factory/config.example.json"), "utf8"));
    expect(configProblems(example)).toEqual([]);
  });
});

describe("packages", () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", "monorepo", ".factory", "config.json"), "utf8"),
  );

  test("the two-package fixture is a valid config", () => {
    expect(configProblems(fixture)).toEqual([]);
  });

  test("a package needs a relative path and its own valid gates", () => {
    expect(
      configProblems({
        repo: "a/b",
        packages: [
          { path: "../x", gates: [] },
          { gates: [{ name: "t", cmd: "x", required: true, role: "unit" }] },
          { path: "p", gates: [], team: ["@a"] },
        ],
      }),
    ).toEqual([
      'packages[0].path: must be relative to the repo root, got "../x"',
      "packages[1].path: required",
      'packages[1].gates[0].role: "unit" is not one of test, lint, typecheck, build, format, audit, docs',
      "packages[2].team: unknown key (allowed: path, gates, always, owners, protectedPaths)",
    ]);
  });

  test("package gates count as gates: doctor, init and the build step's no-gates park agree", () => {
    const onlyPackages = {
      repo: "a/b",
      gates: [],
      packages: [{ path: "p", gates: [{ name: "t", cmd: "x", required: true }] }],
    };
    expect(gateCount(fixture)).toBe(4);
    expect(gateCount(onlyPackages)).toBe(1);
    expect(isFilledIn(JSON.stringify(onlyPackages))).toBe(true);
    const d = repoWith(onlyPackages);
    expect(hasNoGates(d)).toBe(false);
    expect(hasNoGates(repoWith({ repo: "a/b", gates: [], packages: [] }))).toBe(true);
  });
});

describe("gate roles", () => {
  test("a gate may name its role; an unknown role is refused", () => {
    expect(configProblems({ repo: "a/b", gates: [{ name: "unit", cmd: "x", required: true, role: "test" }] })).toEqual(
      [],
    );
    expect(configProblems({ repo: "a/b", gates: [{ name: "unit", cmd: "x", required: true, role: "tests" }] })).toEqual(
      ['gates[0].role: "tests" is not one of test, lint, typecheck, build, format, audit, docs'],
    );
  });

  test("the test gate is the one with role test, else the one named test", () => {
    const named = { name: "test", cmd: "named", required: true };
    const roled = { name: "unit", cmd: "roled", required: true, role: "test" as const };
    expect(testGate([named, roled])?.cmd).toBe("roled");
    expect(testGate([named])?.cmd).toBe("named");
    expect(testGate([{ name: "lint", cmd: "x", required: true, role: "lint" }])).toBeUndefined();
  });
});
