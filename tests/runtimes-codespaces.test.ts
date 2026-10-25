// The codespaces runtime against a fake `gh` that runs the remote script on this machine: the
// worktree arrives without .git, the command's streams and code come back, the directory goes.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodespacesExecution, codespaceArgs } from "../src/adapters/codespaces/execution";
import { runtimeProblems, runtimesFrom } from "../src/runtimes";

const FAKE_GH = join(import.meta.dir, "fixtures/fake-gh");
const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PATH: `${FAKE_GH}:${process.env.PATH}`,
  ...extra,
});
const worktree = () => {
  const d = mkdtempSync(join(tmpdir(), "factory-cs-"));
  for (const sub of [".git", "node_modules", "dist"]) {
    Bun.spawnSync(["mkdir", "-p", join(d, sub)]);
    writeFileSync(join(d, sub, "f"), sub);
  }
  return d;
};

describe("codespaces", () => {
  test("sends the worktree without .git, runs there, answers its streams and code, cleans up", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cs-root-"));
    const log = join(root, "..", `${root.split("/").at(-1)}.log`);
    const spec = { kind: "codespaces", codespace: "cs-1", tokenEnv: "K", root } as const;
    const r = await new CodespacesExecution(spec, env({ K: "tok", FAKE_GH_LOG: log })).run(
      "ls -A | sort | tr '\\n' ' '; printf \"it's\" >&2; exit 3",
      worktree(),
    );
    expect(r).toEqual({ stdout: "dist ", stderr: "it's", code: 3 });
    expect(readdirSync(root)).toEqual([]);
    expect(readFileSync(log, "utf8")).toBe("cs-1 token=tok\n");
  });

  test("the token goes by env only; unset or a failed connection fails the step, never throws", async () => {
    const spec = { kind: "codespaces", codespace: "cs-1", tokenEnv: "K" } as const;
    const unset = await new CodespacesExecution(spec, env()).run("true", worktree());
    expect(unset.runtimeFailed).toBe("codespace cs-1: env var K is not set");
    const { run } = codespaceArgs(spec, "true", "/tmp/x");
    expect(run.join(" ")).not.toContain("tok");
    const down = await new CodespacesExecution(spec, env({ K: "tok", FAKE_GH_DOWN: "1" })).run("true", worktree());
    expect(down.code).toBe(1);
    expect(down.runtimeFailed).toBe("codespace cs-1: gh codespace ssh failed (exit 1):");
    expect(down.stderr).toContain("not found");
    const noGh = await new CodespacesExecution(spec, { K: "tok", PATH: "/nonexistent" }).run("true", worktree());
    expect(noGh.code).toBe(1);
    expect(noGh.runtimeFailed).toStartWith("codespace cs-1:");
  });

  test("a command that fails is the command's failure, not the runtime's", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-cs-root-"));
    const r = await new CodespacesExecution({ kind: "codespaces", codespace: "c", root }, env()).run(
      "echo no >&2; exit 1",
      worktree(),
    );
    expect(r).toEqual({ stdout: "", stderr: "no\n", code: 1 });
  });

  test("machine.json: codespace is required, and the kind builds this adapter", () => {
    expect(runtimesFrom({ cs: { kind: "codespaces", codespace: "cs-1" } }).cs).toBeInstanceOf(CodespacesExecution);
    expect(runtimeProblems({ a: { kind: "codespaces", codespace: "cs-1", tokenEnv: "GH_TOKEN" } })).toEqual([]);
    expect(runtimeProblems({ b: { kind: "codespaces" } })).toEqual(["runtimes.b.codespace: required for codespaces"]);
  });
});
