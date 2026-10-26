// One ACP seam: the same fixture ticket's build stage passes its holdout with two different ACP agents,
// every ACP turn goes through src/agents/acp-client.ts, and an agent that picks another protocol
// version is refused. The two agents are tests/fixtures/agents/fake-acp.ts and fake-acp.py.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { versionProblem } from "../src/agents/acp-client";
import { CommandExecutor } from "../src/agents/executor";
import type { AgentConfig } from "../src/agents/types";
import { readStageArtifacts, validateStepJson } from "../src/artifacts";

const scratch = mkdtempSync(join(tmpdir(), "factory-acp-seam-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = (f: string) => join(import.meta.dir, "fixtures/agents", f);
const SRC = join(import.meta.dir, "../src");

// The ticket: totals subtract where they should add. Its holdout is the one promise, AC-1.
const BUGGY = "export const total = (a, b) => a - b;\n";
const HOLDOUT = `bun -e 'import { total } from "./src/total.js"; process.exit(total(2, 3) === 5 ? 0 : 1)'`;
const FIX = join(scratch, "fix.json");
writeFileSync(FIX, JSON.stringify({ file: "src/total.js", find: "a - b", replace: "a + b" }));

function repo(): string {
  const cwd = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/total.js"), BUGGY);
  mkdirSync(join(cwd, "holdout/01-totals"), { recursive: true });
  writeFileSync(join(cwd, "holdout/01-totals/AC-1.sh"), `${HOLDOUT}\n`);
  return cwd;
}

const holdout = (cwd: string) => Bun.spawnSync(["bash", "holdout/01-totals/AC-1.sh"], { cwd }).exitCode;

async function build(agent: AgentConfig, env: Record<string, string> = {}) {
  const cwd = repo();
  const before = holdout(cwd);
  const executor = new CommandExecutor({ a: agent }, { default: "a" });
  Object.assign(process.env, { FAKE_ACP_FIX: FIX, ...env });
  try {
    const run = await executor.runStage({ stage: "build", issue: 7, cwd, maxBudgetUsd: 1 });
    const { json } = await readStageArtifacts(cwd, 7, "build");
    return {
      exit: run.exitCode,
      before,
      after: holdout(cwd),
      artifact: validateStepJson("build", json).ok,
      code: readFileSync(join(cwd, "src/total.js"), "utf8"),
      stderr: run.stderrTail ?? "",
    };
  } finally {
    for (const k of ["FAKE_ACP_FIX", ...Object.keys(env)]) delete process.env[k];
  }
}

const tsAgent: AgentConfig = { preset: "acp", command: [process.execPath, fixture("fake-acp.ts")] };
const pyAgent: AgentConfig = { preset: "acp", command: ["python3", fixture("fake-acp.py")] };

describe("acp seam", () => {
  test("one ACP seam: the same ticket's build passes its holdout with two different ACP agents", async () => {
    const ts = await build(tsAgent);
    const py = await build(pyAgent);
    expect(ts).toEqual({
      exit: 0,
      before: 1,
      after: 0,
      artifact: true,
      code: "export const total = (a, b) => a + b;\n",
      stderr: "",
    });
    expect(py).toEqual(ts);
  }, 30_000);

  test("an agent that answers another protocol version is refused before any session", async () => {
    const out = await build(tsAgent, { FAKE_ACP_VERSION: "2" });
    expect(out.exit).toBe(1);
    expect(out.stderr).toContain("the agent answered protocol version 2, and this client speaks only 1");
    expect(out.code).toBe(BUGGY);
    expect(versionProblem(1)).toBeUndefined();
    expect(versionProblem(undefined)).toContain("protocol version undefined");
  }, 30_000);

  test("only acp-client.ts speaks ACP, and only the executor and that client start an agent", () => {
    const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .map((d) => relative(SRC, join(d.parentPath, d.name)));
    const body = (f: string) => readFileSync(join(SRC, f), "utf8");
    expect(files.filter((f) => /"session\/(new|prompt)"/.test(body(f)))).toEqual(["agents/acp-client.ts"]);
    // An agent's argv comes from a preset or config.agents; those are read in src/agents only.
    const launchers = files.filter((f) => f.startsWith("agents/") && /\b(Bun\.spawn|spawn)\(/.test(body(f)));
    expect(launchers.sort()).toEqual(["agents/acp-client.ts", "agents/agent-sandbox.ts", "agents/executor.ts"]);
    expect(body("agents/agent-sandbox.ts")).toContain('Bun.spawn(["docker", "rm", "-f", name]');
  });
});
