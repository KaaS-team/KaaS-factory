import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitRmProblem } from "../src/git-rm";
import { stageSettings } from "../src/stage-permissions";

const ROOT = "/work/tree";
const PROTECTED = ["src/payments/**"];

describe("build allow-list for git rm (#52)", () => {
  test("only build may git rm, and bare rm is never allowed", () => {
    for (const stage of ["triage", "plan", "build", "verify", "pr", "retro"] as const) {
      const allow: string[] = JSON.parse(stageSettings(stage, 1)).permissions.allow;
      expect(allow.includes("Bash(git rm *)")).toBe(stage === "build");
      expect(allow.some((r) => r.startsWith("Bash(rm"))).toBe(false);
    }
  });
});

describe("gitRmProblem", () => {
  test("accepts named files inside the worktree", () => {
    expect(gitRmProblem("git rm apps/a/src/inbound.ts apps/b/src/inbound.ts", ROOT, PROTECTED)).toEqual(undefined);
    expect(gitRmProblem("git rm -r -- old/dir", ROOT, PROTECTED)).toEqual(undefined);
  });

  test("refuses paths outside the worktree", () => {
    expect(gitRmProblem("git rm ../other/file.ts", ROOT, PROTECTED)).toBe("../other/file.ts is outside the worktree");
    expect(gitRmProblem("git rm /etc/hosts", ROOT, PROTECTED)).toBe("/etc/hosts is outside the worktree");
    expect(gitRmProblem("git rm .", ROOT, PROTECTED)).toBe(". is outside the worktree");
  });

  test("refuses protected paths, configured and always-protected", () => {
    expect(gitRmProblem("git rm src/payments/charge.ts", ROOT, PROTECTED)).toBe(
      "src/payments/charge.ts is a protected path",
    );
    expect(gitRmProblem("git rm src/x/../payments/charge.ts", ROOT, PROTECTED)).toBe(
      "src/x/../payments/charge.ts is a protected path",
    );
    expect(gitRmProblem("git rm .factory/config.json", ROOT, [])).toBe(".factory/config.json is a protected path");
  });

  test("refuses patterns, odd flags and a bare command", () => {
    expect(gitRmProblem("git rm src/*.ts", ROOT, [])).toBe("src/*.ts is a pattern, name each file");
    expect(gitRmProblem("git rm --cached a.ts", ROOT, [])).toBe("flag --cached is not allowed");
    expect(gitRmProblem("git rm", ROOT, [])).toBe("no path given");
    expect(gitRmProblem("rm a.ts", ROOT, [])).toBe("not a git rm command");
  });
});

describe("guard-paths.sh on git rm", () => {
  const hook = join(import.meta.dir, "..", "template", ".claude", "hooks", "guard-paths.sh");
  async function run(command: string, dir: string): Promise<number> {
    const proc = Bun.spawn([hook], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FACTORY_STAGE: "build" },
    });
    proc.stdin.write(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir }));
    await proc.stdin.end();
    return await proc.exited;
  }

  test("passes an in-tree file, blocks outside and protected ones", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "factory-gitrm-"));
    mkdirSync(join(dir, ".factory"), { recursive: true });
    writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ protectedPaths: PROTECTED }));
    expect(await run("git rm apps/a/inbound.ts", dir)).toBe(0);
    expect(await run("git rm ../escape.ts", dir)).toBe(2);
    expect(await run("git rm src/payments/charge.ts", dir)).toBe(2);
    expect(await run("git rm src/*.ts", dir)).toBe(2);
  });
});
