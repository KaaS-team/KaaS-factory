// `factory doctor` is meant to catch a broken setup before the loop wastes a
// stage finding out. Before this file, "gh on PATH" only checked the binary
// existed, not that it was logged in, and nothing checked python3 (which
// guard-paths.sh silently fails open without — see guard-hook.test.ts) or
// jq (which gates.sh and the CI workflow assume). Audit findings #13.

import { describe, expect, test } from "bun:test";
import { fixDoctor, runDoctor, type DoctorDeps } from "../src/doctor";
import { GitHub, type CommandResult, type CommandRunner } from "../src/github";
import { LABELS, labelsFor } from "../src/labels";
import { parseWorkflowText } from "../src/engine/workflows";

class FakeGitHub extends GitHub {
  constructor(private readonly auth: { ok: boolean; detail: string }) {
    super();
  }
  override async authStatus(): Promise<{ ok: boolean; detail: string }> {
    return this.auth;
  }
  override async listLabels(): Promise<string[]> {
    return LABELS.map((l) => l.name); // doctor's label check isn't what this file is testing
  }
}

class TrackingGitHub extends GitHub {
  readonly ensured: { repo: string; name: string; color: string; description: string }[] = [];
  override async ensureLabel(repo: string, name: string, color: string, description: string): Promise<void> {
    this.ensured.push({ repo, name, color, description });
  }
}

class FakeGit implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: "abc123\n", stderr: "", code: 0 };
  }
}

const files = new Map<string, string>();

function deps(overrides: Partial<{ which: Set<string>; auth: { ok: boolean; detail: string } }> = {}): DoctorDeps {
  const which = overrides.which ?? new Set(["gh", "claude", "python3", "jq"]);
  return {
    github: new FakeGitHub(overrides.auth ?? { ok: true, detail: "Logged in to github.com as octocat" }),
    git: new FakeGit(),
    which: async (bin: string) => which.has(bin),
    fileExists: async () => true,
    readFile: async () => files.get("text") ?? '{"gates": [{"name": "test", "cmd": "true", "required": true}]}',
    isExecutable: async () => files.get("exec") !== "no",
  };
}

const ctx = { repo: "acme/widgets", cloneDir: "/tmp/x", baselineTag: "baseline" };

describe("runDoctor", () => {
  test("all green when every binary is on PATH and gh is authenticated", async () => {
    const checks = await runDoctor(deps(), ctx);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toContain("python3 on PATH");
    expect(checks.map((c) => c.name)).toContain("jq on PATH");
    expect(checks.map((c) => c.name)).toContain("gh authenticated");
  });

  test("flags a missing python3 even though `which gh` succeeds", async () => {
    const checks = await runDoctor(deps({ which: new Set(["gh", "claude", "jq"]) }), ctx);
    const py = checks.find((c) => c.name === "python3 on PATH")!;
    expect(py.ok).toBe(false);
  });

  test("flags a missing jq", async () => {
    const checks = await runDoctor(deps({ which: new Set(["gh", "claude", "python3"]) }), ctx);
    const jqCheck = checks.find((c) => c.name === "jq on PATH")!;
    expect(jqCheck.ok).toBe(false);
  });

  test("gh on PATH but not logged in fails the real auth check, not just the binary check", async () => {
    const checks = await runDoctor(
      deps({ auth: { ok: false, detail: "You are not logged into any GitHub hosts" } }),
      ctx,
    );
    const binCheck = checks.find((c) => c.name === "gh on PATH")!;
    const authCheck = checks.find((c) => c.name === "gh authenticated")!;
    expect(binCheck.ok).toBe(true); // `which gh` still finds the binary
    expect(authCheck.ok).toBe(false);
    expect(authCheck.detail).toContain("not logged into");
  });

  test("reports the tracker's kind and auth: GitHub's is gh's, http asks the tracker", async () => {
    const gh = (await runDoctor(deps(), ctx)).find((c) => c.name.startsWith("tracker:"))!;
    expect(gh).toMatchObject({ name: "tracker: github, authenticated", ok: true });
    const down = { kind: "http" as const, authStatus: async () => ({ ok: false, detail: "tracker GET /me answered 401: bad token" }) };
    const http = (await runDoctor({ ...deps(), tracker: down }, ctx)).find((c) => c.name.startsWith("tracker:"))!;
    expect(http).toMatchObject({ name: "tracker: http, authenticated", ok: false, detail: expect.stringContaining("401") });
  });

  test("flags a config with no gates", async () => {
    files.set("text", '{"gates": []}');
    const checks = await runDoctor(deps(), ctx);
    files.clear();
    expect(checks.find((c) => c.name === ".factory/config.json defines at least one gate")).toMatchObject({ ok: false });
  });

  test("flags TODO markers left in the scaffolded config and charter", async () => {
    files.set("text", "# TODO: fill me in");
    const checks = await runDoctor(deps(), ctx);
    files.clear();
    expect(checks.filter((c) => c.name.includes("no TODO left")).map((c) => c.ok)).toEqual([false, false]);
  });

  test("flags a gates.sh that is not executable", async () => {
    files.set("exec", "no");
    const checks = await runDoctor(deps(), ctx);
    files.clear();
    expect(checks.find((c) => c.name.includes("gates.sh"))!.ok).toBe(false);
  });

  test("FACTORY_MODE=actions needs the workflow file; other modes do not", async () => {
    const noWorkflow = { ...deps(), fileExists: async (p: string) => !p.includes("workflows") };
    const inActions = await runDoctor(noWorkflow, { ...ctx, factoryMode: "actions" });
    expect(inActions.find((c) => c.name.includes("FACTORY_MODE"))!.ok).toBe(false);
    const local = await runDoctor(noWorkflow, ctx);
    expect(local.some((c) => c.name.includes("FACTORY_MODE"))).toBe(false);
  });
});

// Plan v2.6.2 item 1: state moved from one shared FACTORY_HOME/factory.db to
// FACTORY_HOME/<owner>/<repo>/factory.db, and the previous design decision
// stands — never auto-migrate a shared DB into the new per-repo layout, only
// warn. No `legacyStatePath`/`legacyWorkspacesDir` in `ctx` (as in every test
// above) means the check is skipped entirely, not silently passing.
describe("legacy shared state warning", () => {
  test("silent when the caller passes no legacy paths to check", async () => {
    const checks = await runDoctor(deps(), ctx);
    expect(checks.some((c) => c.name.includes("legacy"))).toBe(false);
  });

  test("warns, but never fails the run, when the legacy factory.db still exists", async () => {
    const checks = await runDoctor(deps(), { ...ctx, legacyStatePath: "/home/.factory/factory.db" });
    const check = checks.find((c) => c.name.includes("factory.db"))!;
    expect(check.ok).toBe(false);
    expect(check.warn).toBe(true);
    expect(check.fixable).toBe(false);
    expect(check.detail).toContain("/home/.factory/factory.db");
    expect(checks.every((c) => c.ok || c.warn)).toBe(true); // an all-warn run still counts as passing
  });

  test("warns when the legacy workspaces/ dir still exists", async () => {
    const checks = await runDoctor(deps(), { ...ctx, legacyWorkspacesDir: "/home/.factory/workspaces" });
    const check = checks.find((c) => c.name.includes("workspaces"))!;
    expect(check.ok).toBe(false);
    expect(check.warn).toBe(true);
  });

  test("passes clean when the legacy paths are given but nothing is there", async () => {
    const checks = await runDoctor(
      { ...deps(), fileExists: async () => false },
      { ...ctx, legacyStatePath: "/home/.factory/factory.db", legacyWorkspacesDir: "/home/.factory/workspaces" },
    );
    expect(checks.find((c) => c.name.includes("factory.db"))!.ok).toBe(true);
    expect(checks.find((c) => c.name.includes("workspaces"))!.ok).toBe(true);
  });
});

// Plan v2.11.0 item B: lwp-website never sets `resettable` and must never be
// reset, so it has no reason to keep a baseline tag current. The check now
// only fires for a repo that opted in via `config.resettable`.
describe("baseline tag, gated on resettable", () => {
  test("silent when resettable is unset", async () => {
    const checks = await runDoctor(deps(), ctx);
    expect(checks.some((c) => c.name.includes("baseline tag"))).toBe(false);
  });

  test("fails when resettable is true and the tag doesn't exist", async () => {
    const failingGit: CommandRunner = { run: async () => ({ stdout: "", stderr: "fatal: bad revision 'baseline'", code: 128 }) };
    const checks = await runDoctor({ ...deps(), git: failingGit }, { ...ctx, resettable: true });
    const check = checks.find((c) => c.name.includes("baseline tag"))!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("bad revision");
  });

  test("passes when resettable is true and the tag exists", async () => {
    const checks = await runDoctor(deps(), { ...ctx, resettable: true });
    const check = checks.find((c) => c.name.includes("baseline tag"))!;
    expect(check.ok).toBe(true);
  });
});

describe("agents in doctor", () => {
  const agents = { claude: { preset: "claude" }, codex: { preset: "codex" }, aider: { command: ["aider", "--yes"] }, unused: { preset: "codex" } };

  test("checks the binary of every agent a stage uses, and only those", async () => {
    const checks = await runDoctor(deps({ which: new Set(["gh", "claude", "python3", "jq"]) }), { ...ctx, agents, stages: { default: "claude", verify: "codex", build: "aider" } });
    const on = (n: string) => checks.find((c) => c.name === `${n} on PATH`);
    expect(on("claude")!.ok).toBe(true);
    expect(on("codex")!.ok).toBe(false);
    expect(on("aider")!.ok).toBe(false);
    expect(checks.filter((c) => c.name.endsWith(" on PATH")).map((c) => c.name)).not.toContain("unused on PATH");
  });

  test("a preset-less agent gets a usage warning, a preset agent does not", async () => {
    const checks = await runDoctor(deps({ which: new Set(["gh", "claude", "aider", "python3", "jq"]) }), { ...ctx, agents, stages: { default: "aider" } });
    expect(checks.map((c) => c.name)).toContain('agent "aider" reports usage');
    expect((await runDoctor(deps(), ctx)).map((c) => c.name)).not.toContain('agent "claude" reports usage');
  });

  test("a CLI with no --version flag is not probed", async () => {
    let probed = false;
    const d = { ...deps({ which: new Set(["gh", "mastracode", "python3", "jq"]) }), versionOf: async () => ((probed = true), "x") };
    const checks = await runDoctor(d, { ...ctx, agents: { m: { preset: "mastracode" } }, stages: { default: "m" } });
    expect(probed).toBe(false);
    expect(checks.find((c) => c.name === "mastracode is version 0.42.0")!.ok).toBe(true);
  });

  test("a custom command with no approval-bypass flag fails, one with a flag passes", async () => {
    const which = new Set(["gh", "aider", "python3", "jq"]);
    const run = (command: string[]) => runDoctor(deps({ which }), { ...ctx, agents: { x: { command } }, stages: { default: "x" } });
    const bare = (await run(["aider", "--model", "m"])).find((c) => c.name === 'agent "x" runs without prompting')!;
    expect(bare.ok).toBe(false);
    expect(bare.warn).toBeUndefined();
    expect((await run(["aider", "--yes"])).find((c) => c.name === 'agent "x" runs without prompting')!.ok).toBe(true);
    expect((await run(["tool", "--permission-mode=auto"])).find((c) => c.name === 'agent "x" runs without prompting')!.ok).toBe(true);
  });
});

describe("installed skills drift", () => {
  const shipped = { ".claude/skills/factory-build/SKILL.md": "new text" };
  const drift = async (installed: string | undefined) => {
    const d = { ...deps(), readFile: async (p: string) => (p.endsWith("factory-build/SKILL.md") ? installed : "{}") };
    return (await runDoctor(d, { ...ctx, templateSkills: shipped })).find((c) => c.name === "installed skills match this runner")!;
  };

  test("warns with the fix when an installed skill differs or is missing", async () => {
    for (const installed of ["old text", undefined]) {
      const check = await drift(installed);
      expect(check.ok).toBe(false);
      expect(check.warn).toBe(true);
      expect(check.detail).toContain("factory install --update");
    }
  });

  test("passes when the installed skills equal the template", async () => {
    expect((await drift("new text")).ok).toBe(true);
  });

  test("skips files and directories listed in templateOverrides", async () => {
    const d = { ...deps(), readFile: async (p: string) => (p.endsWith("SKILL.md") ? "customised" : "{}") };
    const check = async (templateOverrides: string[]) =>
      (await runDoctor(d, { ...ctx, templateSkills: shipped, templateOverrides })).find((c) => c.name === "installed skills match this runner")!.ok;
    expect(await check([])).toBe(false);
    expect(await check([".claude/skills/factory-build/SKILL.md"])).toBe(true);
    expect(await check([".claude/skills/factory-build/"])).toBe(true);
    expect(await check([".claude/skills/factory-build"])).toBe(true);
    expect(await check([".claude/skills/factory-buil"])).toBe(false);
  });
});

describe("tmux check", () => {
  const tmuxCheck = async (installed: boolean, tmux?: boolean) =>
    (await runDoctor({ ...deps(), which: async (b: string) => b !== "tmux" || installed }, { ...ctx, tmux })).find((c) => c.name.startsWith("tmux is installed"));

  test("fails when tmux.enabled is set and tmux is missing, and is absent when tmux is off", async () => {
    expect((await tmuxCheck(false, true))!.ok).toBe(false);
    expect((await tmuxCheck(true, true))!.ok).toBe(true);
    expect(await tmuxCheck(false)).toBeUndefined();
  });
});

// Plan v2.11.0 item A: `factory install` calls this right after a real
// install instead of leaving it to a separate `doctor --fix`. This is the
// only place that exercises it: `bin/factory` builds its ScmPort with `makeScm(config)`,
// no seam to inject a fake, so the wiring itself is a source check below.
describe("fixDoctor", () => {
  test("ensures every labelsFor(routes) label, including a repo-added type", async () => {
    const github = new TrackingGitHub();
    const routes = { content: {}, bug: {} }; // "content" is not in TYPE_LABELS, "bug" already is
    await fixDoctor(github, "acme/widgets", routes);
    const want = labelsFor(routes);
    expect(github.ensured.length).toBe(want.length);
    for (const label of want) {
      expect(github.ensured).toContainEqual({ repo: "acme/widgets", name: label.name, color: label.color, description: label.description });
    }
    expect(github.ensured.some((l) => l.name === "content")).toBe(true);
  });

  test("a workflow's own step label is created, the shipped ones are not duplicated", async () => {
    const github = new TrackingGitHub();
    const wf = parseWorkflowText("name: q\nsteps:\n  b: { uses: build, label: factory:building, next: lint }\n  lint: { uses: check, label: factory:linting, run: make lint, next: p }\n  p: { uses: pr, label: factory:in-review }\n");
    if (!wf.ok) throw new Error(wf.problems.join("; "));
    await fixDoctor(github, "acme/widgets", undefined, wf.workflow);
    expect(github.ensured.map((l) => l.name).sort()).toEqual([...LABELS.map((l) => l.name), "factory:linting"].sort());
    const missing = await runDoctor({ ...deps(), readFile: async (p) => (p.endsWith("q.yml") ? "name: q\nsteps:\n  b: { uses: build, label: factory:building, next: lint }\n  lint: { uses: check, label: factory:linting, run: make lint, next: p }\n  p: { uses: pr, label: factory:in-review }\n" : undefined) }, { ...ctx, workflow: "q" });
    expect(missing.find((c) => c.name === "all factory labels exist")!.detail).toContain("factory:linting");
  });

  test("with no routes, ensures exactly LABELS", async () => {
    const github = new TrackingGitHub();
    await fixDoctor(github, "acme/widgets");
    expect(github.ensured.map((l) => l.name).sort()).toEqual(LABELS.map((l) => l.name).sort());
  });
});

describe("runDoctor agent versions", () => {
  const agents = { gemini: { preset: "gemini" } };
  const stages = { default: "gemini" } as const;
  const withVersion = (found: string | undefined) => ({ ...deps({ which: new Set(["gh", "gemini", "python3", "jq"]) }), versionOf: async () => found });

  test("warns, never fails, when the installed version is not the pin", async () => {
    const checks = await runDoctor(withVersion("0.25.2"), { ...ctx, agents, stages });
    const v = checks.find((c) => c.name === "gemini is version 0.61.0")!;
    expect([v.ok, v.warn]).toEqual([false, true]);
    expect(v.detail).toContain("0.25.2");
  });

  test("passes on the pin, and says when --version cannot be read", async () => {
    const ok = await runDoctor(withVersion("0.61.0"), { ...ctx, agents, stages });
    expect(ok.find((c) => c.name === "gemini is version 0.61.0")!.ok).toBe(true);
    const unreadable = await runDoctor(withVersion(undefined), { ...ctx, agents, stages });
    expect(unreadable.find((c) => c.name === "gemini is version 0.61.0")!.detail).toContain("could not read");
  });

  test("every preset that is not verified live warns with the participant path", async () => {
    const { PRESETS } = await import("../src/agents/presets");
    for (const preset of Object.values(PRESETS)) {
      const d = { ...deps({ which: new Set(["gh", preset.binary, "python3", "jq"]) }), versionOf: async () => preset.version };
      const checks = await runDoctor(d, { ...ctx, agents: { a: { preset: preset.name } }, stages: { default: "a" } });
      const v = checks.find((c) => c.name === `agent "a" is verified`);
      expect(v === undefined, preset.name).toBe(preset.verified);
      expect(checks.filter((c) => !c.ok && !c.warn), preset.name).toEqual([]);
    }
  });

  test("the configured workflow: the bundled one passes, a broken repo copy or a missing name fails", async () => {
    const reading = (repoFile?: string): DoctorDeps => ({
      ...deps(),
      readFile: async (path) => (path.startsWith("/tmp/x/.factory/workflows/") ? repoFile : Bun.file(path).text().catch(() => undefined)),
    });
    const check = async (d: DoctorDeps, workflow: string) => (await runDoctor(d, { ...ctx, workflow })).find((c) => c.name === `workflow ${workflow} is valid`)!;
    expect((await check(reading(), "feature-to-pr")).ok).toBe(true);
    const broken = await check(reading("name: x\nsteps:\n  a: { uses: nope, label: l }\n"), "feature-to-pr");
    expect(broken.ok).toBe(false);
    expect(broken.detail).toContain('"nope" is not a step type');
    const missing = await check(reading(), "no-such-flow");
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("no .factory/workflows/no-such-flow.yml");
  });
});

describe("doctor: mcp: servers", () => {
  const flow = "name: m\nsteps:\n  b: { uses: build, label: factory:building, mcp: [docs, tracker], next: p }\n  p: { uses: pr, label: factory:in-review }\n";
  const reading = (registry?: string): DoctorDeps => ({
    ...deps(),
    readFile: async (path) => (path.endsWith("workflows/m.yml") ? flow : path.endsWith(".factory/mcp.json") ? registry : undefined),
  });
  const check = async (registry?: string) => (await runDoctor(reading(registry), { ...ctx, workflow: "m" })).find((c) => c.name.startsWith("every mcp: server"));

  test("every named server is in .factory/mcp.json", async () => {
    expect((await check(JSON.stringify({ mcpServers: { docs: {}, tracker: {} } })))!.ok).toBe(true);
  });
  test("a name the registry lacks, or no registry, fails with the name", async () => {
    const missing = (await check(JSON.stringify({ mcpServers: { docs: {} } })))!;
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('"tracker" is not in .factory/mcp.json');
    expect((await check(undefined))!.detail).toContain(".factory/mcp.json not found");
  });
  test("a workflow that names no server adds no check", async () => {
    expect(await runDoctor(deps(), { ...ctx, workflow: "feature-to-pr" }).then((cs) => cs.find((c) => c.name.startsWith("every mcp:")))).toBeUndefined();
  });
});

describe("doctor: runtimes", () => {
  const flow = "name: m\nsteps:\n  l: { uses: check, label: factory:linting, run: make lint, runtime: gpu, next: p }\n  p: { uses: pr, label: factory:in-review }\n";
  const reading: DoctorDeps = { ...deps(), readFile: async (path) => (path.endsWith("workflows/m.yml") ? flow : undefined) };
  const check = async (runtimeNames: string[], workflow = "m") =>
    (await runDoctor(reading, { ...ctx, workflow, runtime: { gates: "lwpr" }, runtimeNames })).find((c) => c.name.startsWith("every runtime"));

  test("a name this machine has passes; one it lacks fails with the name", async () => {
    expect((await check(["local", "lwpr", "gpu"]))!.ok).toBe(true);
    const missing = (await check(["local", "lwpr"]))!;
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('steps.l.runtime: no runtime "gpu"');
  });
});
