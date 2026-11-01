import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSettings } from "../src/stage-permissions";

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

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "guard-paths.sh");

function project(protectedPaths: unknown): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-gitrm-"));
  mkdirSync(join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify({ protectedPaths }));
  return dir;
}

// Runs the real hook as a build stage: JSON payload on stdin, exit code and stderr back.
async function run(command: string, dir: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    ["python3", "-c", "import subprocess,sys;sys.exit(subprocess.call(['bash',sys.argv[1]]))", HOOK],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, FACTORY_STAGE: "build" },
    },
  );
  proc.stdin.write(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir }));
  await proc.stdin.end();
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

async function refused(command: string, reason: string, dir = project(PROTECTED)): Promise<void> {
  const result = await run(command, dir);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(`guard-paths: blocked git rm: ${reason}.`);
  rmSync(dir, { recursive: true, force: true });
}

describe("guard-paths.sh on git rm (the one implementation)", () => {
  test("accepts named files inside the worktree", async () => {
    const dir = project(PROTECTED);
    expect((await run("git rm apps/a/src/inbound.ts apps/b/src/inbound.ts", dir)).code).toBe(0);
    expect((await run("git rm -f -- old/file.ts", dir)).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses paths outside the worktree", async () => {
    await refused("git rm ../other/file.ts", "../other/file.ts is outside the worktree");
    await refused("git rm /etc/hosts", "/etc/hosts is outside the worktree");
    await refused("git rm .", ". is outside the worktree");
  });

  test("refuses protected paths, configured and always-protected", async () => {
    await refused("git rm src/payments/charge.ts", "src/payments/charge.ts is a protected path");
    await refused("git rm -r .claude", "only -f, -q, --quiet and --ignore-unmatch are allowed");
    await refused("git rm .claude", ".claude is a protected path");
    await refused("git rm :(top)src/payments/charge.ts", "name each plain file, no patterns");
    await refused("git rm src/x/../payments/charge.ts", "src/x/../payments/charge.ts is a protected path");
    await refused("git rm .factory/config.json", ".factory/config.json is a protected path", project([]));
  });

  test("refuses patterns, odd flags and a bare command", async () => {
    await refused("git rm src/*.ts", "name each plain file, no patterns");
    await refused("git rm --cached a.ts", "only -f, -q, --quiet and --ignore-unmatch are allowed");
    await refused("git rm", "name each plain file, no patterns");
    const dir = project([]);
    expect((await run("rm a.ts", dir)).code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("compares protected paths without case", async () => {
    await refused("git rm SRC/payments/x.ts", "SRC/payments/x.ts is a protected path");
    await refused("git rm Src/Payments/x.ts", "Src/Payments/x.ts is a protected path", project(["SRC/Pay*/**"]));
    await refused("git rm .Claude/settings.json", ".Claude/settings.json is a protected path");
    await refused("git rm .FACTORY/config.json", ".FACTORY/config.json is a protected path", project([]));
  });

  test("bypass shapes are refused: quotes, global options, brace globs, bad config", async () => {
    await refused(
      'git rm "src/payments/x.ts"',
      "name each plain file, no patterns (quotes and escapes are masked, so they are refused)",
    );
    await refused(
      "git rm 'src/payments/x.ts'",
      "name each plain file, no patterns (quotes and escapes are masked, so they are refused)",
    );
    await refused(
      "git rm src/pay\\ments/x.ts",
      "name each plain file, no patterns (quotes and escapes are masked, so they are refused)",
    );
    await refused(
      "git rm src/payments/$X.ts",
      "name each plain file, no patterns (quotes and escapes are masked, so they are refused)",
    );
    await refused("git -C . rm src/payments/x.ts", "options before rm are not allowed");
    await refused("git rm a.ts && git rm SRC/payments/x.ts", "SRC/payments/x.ts is a protected path");
    await refused(
      "git rm a.ts",
      "a brace glob in protectedPaths cannot be matched here (fails closed)",
      project(["{a,b}/**"]),
    );
    await refused("git rm a.ts", "protectedPaths is not a list of strings (fails closed)", project("src/**"));
    await refused("git rm a.ts", "protectedPaths is not a list of strings (fails closed)", project([1]));
    const dir = project([]);
    writeFileSync(join(dir, ".factory", "config.json"), "{");
    await refused("git rm a.ts", "config.json cannot be read (fails closed)", dir);
  });
});
