// The README claims the agent cannot read the runner's credentials; the
// template's deny rules are what make that true. Also structural: every hook
// file is registered, executable and tested, and nothing points at one machine.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CLAUDE_DIR = join(ROOT, "template", ".claude");
const settings = JSON.parse(readFileSync(join(CLAUDE_DIR, "settings.json"), "utf8"));
type Hook = { matcher?: string; hooks: Array<{ command: string }> };
const registered: Array<{ event: string; matcher: string; command: string }> = Object.entries(
  settings.hooks as Record<string, Hook[]>,
).flatMap(([event, groups]) =>
  groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher ?? "", command: h.command }))),
);
const hookFiles = readdirSync(join(CLAUDE_DIR, "hooks"));

test("template denies reading gh and ssh credentials, and pushing", () => {
  for (const rule of ["Read(~/.config/gh/**)", "Read(~/.ssh/**)", "Read(./.env*)", "Bash(gh *)", "Bash(git push*)"]) {
    expect(settings.permissions.deny).toContain(rule);
  }
});

test("every hook file is registered, and every registration is an executable hook file", () => {
  expect(registered.map((r) => r.command.replace(".claude/hooks/", "")).sort()).toEqual([...hookFiles].sort());
  for (const file of hookFiles) expect(statSync(join(CLAUDE_DIR, "hooks", file)).mode & 0o111).toBeGreaterThan(0);
});

// guard-paths.sh handles these tools; a matcher without one lets that tool skip
// the guard (NotebookEdit did, before v2.13).
test("guard-paths.sh is registered for every tool it guards", () => {
  const guard = registered.find((r) => r.command.endsWith("guard-paths.sh"))!;
  expect(guard.event).toBe("PreToolUse");
  expect(guard.matcher.split("|").sort()).toEqual(["Agent", "Bash", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
});

test("settings name their schema, and each stop hook is on its event", () => {
  expect(settings.$schema).toBe("https://json.schemastore.org/claude-code-settings.json");
  expect(
    registered
      .filter((r) => r.event.endsWith("Stop"))
      .map((r) => `${r.event} ${r.command}`)
      .sort(),
  ).toEqual(["Stop .claude/hooks/stop-artifact.sh", "Stop .claude/hooks/stop-verifier-evidence.sh"]);
});

test("post-edit-check.sh runs after every file edit, with time for its 60s check", () => {
  const hook = registered.find((r) => r.command.endsWith("post-edit-check.sh"))!;
  expect(hook.event).toBe("PostToolUse");
  expect(hook.matcher.split("|").sort()).toEqual(["Edit", "MultiEdit", "Write"]);
  expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBeGreaterThan(60);
});

test("every hook file has a test that runs it", () => {
  const tests = readdirSync(join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(ROOT, "tests", f), "utf8"));
  for (const file of hookFiles) expect(tests.some((t) => t.includes(`"hooks", "${file}"`))).toBe(true);
});

// The template ships to other people's repos: a path into this machine breaks there.
test("nothing in template/ or template-ci/ points at one machine's home", () => {
  const files = Bun.spawnSync(["find", join(ROOT, "template"), join(ROOT, "template-ci"), "-type", "f"])
    .stdout.toString()
    .trim()
    .split("\n");
  const hits = files
    .filter((f) => /\/Users\/|\/home\/[a-z]|~\/\.claude|\$HOME\/\.claude/.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(ROOT.length + 1));
  expect(hits).toEqual([]);
});
