// machine.json `llmGateway`: each stage run gets its own key from a LiteLLM gateway, capped at the
// stage's maxBudgetUsd, and the agent sees that key and nothing else: no master key, no provider key.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgs } from "../src/adapters/microsandbox/execution";
import { CommandExecutor } from "../src/agents/executor";
import { loadMachineConfig, machineGateway } from "../src/machine";

const MASTER = "fake-master-7m1";
const STAGE_KEY = "sk-fake-stage-7m1";
const calls: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let mintStatus = 200;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    calls.push({ path, auth: req.headers.get("authorization"), body: (await req.json()) as Record<string, unknown> });
    if (path === "/key/generate")
      return mintStatus === 200 ? Response.json({ key: STAGE_KEY }) : new Response("no", { status: mintStatus });
    return Response.json({ deleted_keys: [STAGE_KEY] });
  },
});
afterAll(() => server.stop(true));
const gateway = { url: `http://127.0.0.1:${server.port}`, masterKey: MASTER };

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "factory-gateway-"));
  mkdirSync(join(d, ".claude/skills/factory-plan"), { recursive: true });
  writeFileSync(join(d, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
  return d;
}

// A codex-preset agent whose command only records the env it was given.
const recorder = { preset: "codex", command: ["sh", "-c", 'env > "$FACTORY_ARTIFACT_DIR/env"'] };

describe("llmGateway", () => {
  test("a stage mints a key capped at its budget, the agent sees only that key, and the key is revoked", async () => {
    calls.length = 0;
    const d = repo();
    const saved = { ...process.env };
    process.env.OPENAI_API_KEY = "fake-host-provider-7m1";
    process.env.FACTORY_LLM_GATEWAY_KEY = MASTER;
    try {
      await new CommandExecutor({ x: recorder }, { default: "x" }, {}, undefined, undefined, gateway).runStage({
        stage: "plan",
        issue: 7,
        cwd: d,
        maxBudgetUsd: 2,
        timeoutMinutes: 10,
      });
    } finally {
      process.env = saved;
    }
    const env = readFileSync(join(d, ".factory/runs/issue-7/env"), "utf8");
    expect(env).toContain(`OPENAI_API_KEY=${STAGE_KEY}\n`);
    expect(env).toContain(`OPENAI_BASE_URL=${gateway.url}/v1\n`);
    expect(env).not.toContain(MASTER);
    expect(env).not.toContain("fake-host-provider-7m1");
    expect(calls.map((c) => c.path)).toEqual(["/key/generate", "/key/delete"]);
    expect(calls.every((c) => c.auth === `Bearer ${MASTER}`)).toBe(true);
    expect(calls[0]!.body).toEqual({ max_budget: 2, duration: "15m", metadata: { issue: 7, stage: "plan" } });
    expect(calls[1]!.body).toEqual({ keys: [STAGE_KEY] });
  });

  test("a claude stage gets the gateway as its base URL and loses the host's Anthropic key", async () => {
    const d = repo();
    const bin = mkdtempSync(join(tmpdir(), "factory-gateway-bin-"));
    writeFileSync(join(bin, "claude"), '#!/bin/sh\nenv > "$FACTORY_ARTIFACT_DIR/env"\n', { mode: 0o755 });
    const saved = { ...process.env };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.ANTHROPIC_API_KEY = "fake-host-anthropic-7m1";
    try {
      await new CommandExecutor(
        { c: { preset: "claude" } },
        { default: "c" },
        {},
        undefined,
        undefined,
        gateway,
      ).runStage({ stage: "plan", issue: 8, cwd: d, maxBudgetUsd: 2 });
    } finally {
      process.env = saved;
    }
    const env = readFileSync(join(d, ".factory/runs/issue-8/env"), "utf8");
    expect(env).toContain(`ANTHROPIC_AUTH_TOKEN=${STAGE_KEY}\n`);
    expect(env).toContain(`ANTHROPIC_BASE_URL=${gateway.url}\n`);
    expect(env).not.toContain("fake-host-anthropic-7m1");
  });

  test("a failed mint stops the stage before the agent starts", async () => {
    calls.length = 0;
    mintStatus = 500;
    const d = repo();
    try {
      await expect(
        new CommandExecutor({ x: recorder }, { default: "x" }, {}, undefined, undefined, gateway).runStage({
          stage: "plan",
          issue: 7,
          cwd: d,
          maxBudgetUsd: 2,
        }),
      ).rejects.toThrow("llmGateway: /key/generate answered HTTP 500");
    } finally {
      mintStatus = 200;
    }
    expect(calls.map((c) => c.path)).toEqual(["/key/generate"]);
  });

  test("an agent with no gateway mapping is refused before any key is minted", async () => {
    calls.length = 0;
    const ex = new CommandExecutor({ x: { command: ["true"] } }, { default: "x" }, {}, undefined, undefined, gateway);
    await expect(ex.runStage({ stage: "plan", issue: 7, cwd: repo(), maxBudgetUsd: 2 })).rejects.toThrow(
      "only these presets can call through one: claude, codex",
    );
    expect(calls).toEqual([]);
  });

  test("in the agentRuntime VM the stage key replaces the runtime's provider secrets", async () => {
    const d = repo();
    const argvFile = join(d, "msb-argv");
    const saved = { ...process.env };
    process.env.PATH = `${join(import.meta.dir, "fixtures", "runtimes")}:${saved.PATH}`;
    process.env.MSB_ARGV_FILE = argvFile;
    try {
      await new CommandExecutor(
        { x: recorder },
        { default: "x" },
        {},
        undefined,
        {
          kind: "microsandbox",
          image: "node:22-slim",
          allow: ["127.0.0.1", "github.com"],
          secrets: ["OPENAI_API_KEY@api.openai.com", "GH_READ@github.com"],
        },
        gateway,
      ).runStage({ stage: "plan", issue: 7, cwd: d, maxBudgetUsd: 2 });
    } finally {
      process.env = saved;
    }
    const argv = readFileSync(argvFile, "utf8").split("\n");
    const secrets = argv.flatMap((a, i) => (argv[i - 1] === "--secret" ? [a] : []));
    expect(secrets).toEqual(["GH_READ@github.com", "OPENAI_API_KEY@127.0.0.1"]);
    expect(argv).toContain(`OPENAI_BASE_URL=${gateway.url}/v1`);
    expect(argv.join(" ")).not.toContain(STAGE_KEY);
  });

  test("in a VM the key is an msb secret toward the gateway host, never a guest env value", () => {
    const argv = agentArgs(
      { kind: "microsandbox", image: "node:22-slim", allow: ["llm.example.com"] },
      {
        argv: ["codex"],
        cwd: "/w",
        mounts: [],
        env: { OPENAI_BASE_URL: "https://llm.example.com/v1" },
        name: "n",
        secrets: ["OPENAI_API_KEY@llm.example.com"],
      },
      (p) => p,
    );
    expect(argv.join(" ")).toContain("--secret OPENAI_API_KEY@llm.example.com");
    expect(argv.join(" ")).not.toContain("OPENAI_API_KEY=");
  });
});

describe("machine.json llmGateway", () => {
  function home(machine: unknown): NodeJS.ProcessEnv {
    const d = mkdtempSync(join(tmpdir(), "factory-gateway-home-"));
    writeFileSync(join(d, "machine.json"), JSON.stringify(machine));
    return { FACTORY_HOME: d };
  }

  test("needs an https URL", () => {
    expect(() => loadMachineConfig(home({ slots: 1, llmGateway: { url: "http://llm.example.com" } }))).toThrow(
      '"llmGateway.url" must be an https URL',
    );
  });

  test("needs its host in the agentRuntime's allow list", () => {
    const runtimes = { vm: { kind: "microsandbox", image: "node:22-slim", allow: ["github.com"] } };
    expect(() =>
      loadMachineConfig(
        home({ slots: 1, runtimes, agentRuntime: "vm", llmGateway: { url: "https://llm.example.com" } }),
      ),
    ).toThrow("must list the llmGateway host llm.example.com");
  });

  test("refuses to start without the master key, and holds it once set", () => {
    const env = home({ slots: 1, llmGateway: { url: "https://llm.example.com" } });
    const m = loadMachineConfig(env);
    expect(() => machineGateway(m, env)).toThrow("FACTORY_LLM_GATEWAY_KEY is not set");
    expect(machineGateway(m, { ...env, FACTORY_LLM_GATEWAY_KEY: MASTER })).toEqual({
      url: "https://llm.example.com",
      masterKey: MASTER,
    });
  });
});
