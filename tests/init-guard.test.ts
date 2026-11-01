// Issue 153: the init config protects the Makefile, and the guard hook compares paths without
// case and covers Grep and Glob like Read.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initConfig } from "../src/init";
import { BUILD_SCRIPT_GLOBS, withBuildScriptsProtected } from "../src/init-guard";
import { touchesProtectedPath } from "../src/boundary";

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "guard-paths.sh");

function scratch(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-i153-"));
  mkdirSync(join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ protectedPaths: [] }));
  return dir;
}

async function runHook(input: unknown, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const dir = scratch();
  try {
    const { FACTORY_STAGE: _s, FACTORY_HIDDEN_PATHS: _h, ...base } = process.env;
    const proc = Bun.spawn([HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...base, CLAUDE_PROJECT_DIR: dir, ...env },
    });
    const withDir = JSON.parse(JSON.stringify(input).replaceAll("PROJECT", dir));
    proc.stdin.write(JSON.stringify(withDir));
    await proc.stdin.end();
    const stderr = await new Response(proc.stderr).text();
    return { code: await proc.exited, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const stack = { name: "make", setup: [], gates: [], commands: ["make *"], notes: [] };
const stage = { FACTORY_STAGE: "build", FACTORY_HIDDEN_PATHS: "holdout/**" };

describe("factory init protects build scripts", () => {
  test("the generated config protects the Makefile and *.mk files", () => {
    const config = initConfig({ protectedPaths: ["src/pay/**"] }, stack, undefined);
    const globs = config.protectedPaths as string[];
    expect(globs).toContain("src/pay/**");
    expect(touchesProtectedPath(["Makefile", "sub/Makefile", "rules.mk", "a/b/c.mk", "GNUmakefile"], globs)).toEqual([
      "Makefile",
      "sub/Makefile",
      "rules.mk",
      "a/b/c.mk",
      "GNUmakefile",
    ]);
  });

  test("a config with no protectedPaths gets exactly the build-script globs, once each", () => {
    const out = withBuildScriptsProtected({ protectedPaths: [...BUILD_SCRIPT_GLOBS] });
    expect(out.protectedPaths).toEqual([...BUILD_SCRIPT_GLOBS]);
    expect(withBuildScriptsProtected({}).protectedPaths).toEqual([...BUILD_SCRIPT_GLOBS]);
    expect(withBuildScriptsProtected({ protectedPaths: "oops" as unknown }).protectedPaths).toEqual([
      ...BUILD_SCRIPT_GLOBS,
    ]);
  });
});

describe("guard-paths.sh without case, and Grep and Glob", () => {
  for (const path of [
    ".Claude/settings.json",
    ".CLAUDE/hooks/x.sh",
    ".Agents/skills/a.md",
    ".FACTORY/config.json",
    ".Factory/Runs/x.json",
  ]) {
    test(`blocks an Edit to ${path}`, async () => {
      const { code, stderr } = await runHook({ tool_name: "Edit", tool_input: { file_path: `PROJECT/${path}` } }, {});
      expect(code).toBe(2);
      expect(stderr).toContain("protected");
    });
  }

  test("still lets a stage write .factory/runs", async () => {
    const { code } = await runHook(
      { tool_name: "Write", tool_input: { file_path: "PROJECT/.factory/runs/1/x.json" } },
      {},
    );
    expect(code).toBe(0);
  });

  test("blocks a Grep on a hidden root, in any case", async () => {
    for (const path of ["PROJECT/holdout", "PROJECT/HoldOut/a.ts"]) {
      const { code, stderr } = await runHook({ tool_name: "Grep", tool_input: { pattern: "x", path } }, stage);
      expect(code).toBe(2);
      expect(stderr).toContain("graded");
    }
  });

  test("blocks a Grep or Glob whose pattern or glob names a hidden root", async () => {
    const grep = await runHook({ tool_name: "Grep", tool_input: { pattern: "x", glob: "holdout/**" } }, stage);
    const glob = await runHook({ tool_name: "Glob", tool_input: { pattern: "HOLDOUT/**/*.ts" } }, stage);
    const nonString = await runHook({ tool_name: "Glob", tool_input: { pattern: ["holdout"] } }, stage);
    expect([grep.code, glob.code, nonString.code]).toEqual([2, 2, 2]);
  });

  test("lets a Grep elsewhere through, and any Grep when nothing is hidden", async () => {
    const ok = await runHook({ tool_name: "Grep", tool_input: { pattern: "x", path: "PROJECT/src" } }, stage);
    const none = await runHook({ tool_name: "Grep", tool_input: { pattern: "holdout", path: "PROJECT/holdout" } }, {});
    expect([ok.code, none.code]).toEqual([0, 0]);
  });
});
