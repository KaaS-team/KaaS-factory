// A read-only ACP stage in a microVM gets the worktree mounted read-only, so an agent that leaves
// the bridge's process group still cannot write; a writing stage keeps a writable mount.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgs, type MicrosandboxSpec } from "../src/adapters/microsandbox/execution";
import { CommandExecutor } from "../src/agents/executor";
import { DEFAULT_VM, defaultRuntime } from "../src/runtimes";

const FAKE = join(import.meta.dir, "fixtures/agents/fake-acp.ts");
const spec: MicrosandboxSpec = { kind: "microsandbox", image: "node:22-slim" };

async function mountFor(stage: "plan" | "build"): Promise<{ dir: string; mount: string }> {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `factory-ro-${stage}-`)));
  const skill = join(d, `.claude/skills/factory-${stage}`);
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\nname: factory-${stage}\n---\nDo it.\n`);
  const argvFile = join(d, "msb-argv");
  const saved = { PATH: process.env.PATH, MSB_ARGV_FILE: process.env.MSB_ARGV_FILE };
  process.env.PATH = `${join(import.meta.dir, "fixtures", "runtimes")}:${saved.PATH}`;
  process.env.MSB_ARGV_FILE = argvFile;
  try {
    await new CommandExecutor(
      { goose: { preset: "acp", command: [process.execPath, FAKE] } },
      { default: "goose" },
      {},
      undefined,
      spec,
    ).runStage({ stage, issue: 3, cwd: d, maxBudgetUsd: 1 });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.MSB_ARGV_FILE === undefined) delete process.env.MSB_ARGV_FILE;
    else process.env.MSB_ARGV_FILE = saved.MSB_ARGV_FILE;
  }
  const argv = readFileSync(argvFile, "utf8").trim().split("\n");
  return { dir: d, mount: argv.find((a, i) => argv[i - 1] === "-v" && a.startsWith(`${d}:`))! };
}

describe("acp read-only mount", () => {
  test("a read-only ACP stage mounts the worktree read-only in the VM, a build stage does not", async () => {
    const plan = await mountFor("plan");
    expect(plan.mount).toBe(`${plan.dir}:${plan.dir}:ro`);
    const build = await mountFor("build");
    expect(build.mount).toBe(`${build.dir}:${build.dir}`);
  });

  // The real msb, where this machine has it: the guest's write to a :ro mount fails.
  test.skipIf(defaultRuntime().spec.kind !== "microsandbox")("msb refuses a write to the read-only mount", () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "factory-ro-live-")));
    const argv = agentArgs(DEFAULT_VM, {
      argv: ["bash", "-c", "echo x > sneaked.txt"],
      cwd: d,
      mounts: [],
      env: {},
      name: `factory-ro-${crypto.randomUUID()}`,
      readOnly: true,
    });
    const r = Bun.spawnSync(argv, { stderr: "pipe", stdout: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("Read-only file system");
  });
});
