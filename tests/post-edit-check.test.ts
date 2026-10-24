// Exercises template/.claude/hooks/post-edit-check.sh as Claude Code calls it
// on PostToolUse: off unless the build stage and postEditCommand say so.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "..", "template", ".claude", "hooks", "post-edit-check.sh");
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "factory-post-edit-"));
  mkdirSync(join(cwd, ".factory"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const configure = (postEditCommand: unknown) =>
  writeFileSync(join(cwd, ".factory", "config.json"), JSON.stringify({ postEditCommand }));

async function edited(
  file: string,
  stage: string | null = "build",
  extra: Record<string, string> = {},
): Promise<{ code: number; reason?: string }> {
  const { FACTORY_STAGE: _s, ...base } = process.env;
  const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: file }, cwd };
  const proc = Bun.spawn(["bash", HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: stage ? { ...base, ...extra, FACTORY_STAGE: stage } : base,
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const reply = out.trim() ? (JSON.parse(out) as { decision: string; reason: string }) : undefined;
  if (reply) expect(reply.decision).toBe("block");
  return { code, reason: reply?.reason };
}

test("hands a failing check's output back, with the file as one argument", async () => {
  configure(["sh", "-c", 'echo "bad: $1"; exit 3', "check", "{file}"]);
  const { reason } = await edited("src/a b;rm -rf x.ts");
  expect(reason).toContain("failed on src/a b;rm -rf x.ts (exit 3)");
  expect(reason).toContain("bad: src/a b;rm -rf x.ts");
});

test("passes when the check passes", async () => {
  configure(["sh", "-c", "exit 0"]);
  expect(await edited("src/a.ts")).toEqual({ code: 0, reason: undefined });
});

test("reports a command that cannot run", async () => {
  configure(["no-such-checker-xyz", "{file}"]);
  expect((await edited("src/a.ts")).reason).toContain("(exit not run)");
});

test("skips the factory's own files: .factory/, the artifact dir and the scratch dir", async () => {
  configure(["sh", "-c", "exit 1"]);
  expect((await edited(".factory/runs/issue-1/status-comment.md")).reason).toBeUndefined();
  expect((await edited(join(cwd, ".factory", "runs", "issue-1", "build.json"))).reason).toBeUndefined();
  const scratch = join(cwd, "..", `${cwd.split("/").pop()}-scratch`);
  expect((await edited(join(scratch, "notes.md"), "build", { FACTORY_SCRATCH_DIR: scratch })).reason).toBeUndefined();
  expect((await edited("src/a.ts")).reason).toContain("(exit 1)");
});

test("off when unset, empty, malformed, or outside the build stage", async () => {
  expect((await edited("src/a.ts")).reason).toBeUndefined(); // no config file
  for (const value of [[], null, "biome check {file}", [1]]) {
    configure(value);
    expect((await edited("src/a.ts")).reason).toBeUndefined();
  }
  configure(["sh", "-c", "exit 1"]);
  expect((await edited("src/a.ts", "verify")).reason).toBeUndefined();
  expect((await edited("src/a.ts", null)).reason).toBeUndefined();
});
