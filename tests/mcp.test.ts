// Per-step MCP: a workflow step's `mcp: [names]` picks servers from
// .factory/mcp.json, and only those reach that step's claude run.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { claudeArgs, claudePreset } from "../src/agents/presets/claude";
import { parseWorkflowText } from "../src/engine/workflows";
import { McpError, mcpServersFor } from "../src/mcp";

const scratch = mkdtempSync(join(tmpdir(), "mcp-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function repoWith(servers: Record<string, unknown> | undefined): string {
  const dir = mkdtempSync(join(scratch, "repo-"));
  if (servers) {
    mkdirSync(join(dir, ".factory"), { recursive: true });
    writeFileSync(join(dir, ".factory/mcp.json"), JSON.stringify({ mcpServers: servers }));
  }
  return dir;
}

const DOCS = { command: "docs-mcp", args: ["--stdio"] };
const TRACKER = { type: "http", url: "https://tracker.example/mcp" };

describe("workflow mcp:", () => {
  const flow = (mcp: string, uses = "build") =>
    parseWorkflowText(
      `name: m\nsteps:\n  b:\n    uses: ${uses}\n    label: factory:building\n${uses === "check" ? "    run: make lint\n" : ""}    mcp: ${mcp}\n    next: p\n  p:\n    uses: pr\n    label: factory:in-review\n`,
    );

  test("an agent step keeps its server names", () => {
    const r = flow("[docs, tracker]");
    expect(r.ok && r.workflow.steps.b!.mcp).toEqual(["docs", "tracker"]);
  });
  test.each([
    ["docs", /a list of server names/, "build"],
    ['["has space"]', /a list of server names/, "build"],
    ["[docs]", /a check step runs no agent/, "check"],
  ])("refuses %s", (mcp, msg, uses) => {
    const r = flow(mcp, uses);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join("\n")).toMatch(msg);
  });
});

describe("mcpServersFor", () => {
  test("returns only the servers asked for", () => {
    expect(mcpServersFor(repoWith({ docs: DOCS, tracker: TRACKER }), ["docs"])).toEqual({ docs: DOCS });
  });
  test("an unknown name or a missing registry throws before anything runs", () => {
    expect(() => mcpServersFor(repoWith({ docs: DOCS }), ["tracker"])).toThrow(McpError);
    expect(() => mcpServersFor(repoWith({ docs: DOCS }), ["tracker"])).toThrow(
      /"tracker" is not in \.factory\/mcp\.json \(has: docs\)/,
    );
    expect(() => mcpServersFor(repoWith(undefined), ["docs"])).toThrow(/not found/);
  });
});

describe("claude argv", () => {
  const opts = { stage: "build" as const, issue: 3, cwd: "/w", maxBudgetUsd: 1 };
  test("--mcp-config sits right before --strict-mcp-config, and the servers' tools are allowed", () => {
    const argv = claudeArgs({ ...opts, mcp: { docs: DOCS } }, "", "/s/mcp.json");
    const strict = argv.indexOf("--strict-mcp-config");
    expect(argv.slice(strict - 2, strict + 1)).toEqual(["--mcp-config", "/s/mcp.json", "--strict-mcp-config"]);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).permissions.allow).toContain("mcp__docs");
  });
  test("no servers: no --mcp-config and no mcp__ rule", () => {
    const argv = claudeArgs(opts);
    expect(argv).not.toContain("--mcp-config");
    expect(argv[argv.indexOf("--settings") + 1]).not.toContain("mcp__");
  });
  test("the preset is the one that loads MCP", () => expect(claudePreset.mcp).toBe(true));
});

describe("the executor", () => {
  test("hands claude a config file holding just the step's servers", async () => {
    const bin = mkdtempSync(join(scratch, "bin-"));
    const out = join(bin, "seen.json");
    // A stand-in claude: records the --mcp-config file it was given, then exits.
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = --mcp-config ]; then cp "$2" ${out}; fi; shift; done\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    try {
      const cwd = repoWith(undefined);
      await new CommandExecutor({ claude: { preset: "claude" } }, { default: "claude" }).runStage({
        stage: "build",
        issue: 4,
        cwd,
        maxBudgetUsd: 1,
        mcp: { docs: DOCS },
      });
    } finally {
      process.env.PATH = saved;
    }
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ mcpServers: { docs: DOCS } });
  });

  test("a step with servers refuses an agent that cannot load them", async () => {
    const exec = new CommandExecutor({ sh: { command: ["true"] } }, { default: "sh" });
    expect(
      exec.runStage({ stage: "build", issue: 5, cwd: repoWith(undefined), maxBudgetUsd: 1, mcp: { docs: DOCS } }),
    ).rejects.toThrow(McpError);
  });
});
