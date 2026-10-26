// The factory repo's own Claude Code setup: what a session here loads must point at
// files that exist, so a rename cannot leave AGENTS.md or a rule pointing at nothing.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
// Scans the tree, not `git ls-files`: check-mutations runs this in a copy without .git.
const matchesAFile = (glob: string): boolean => {
  for (const f of new Bun.Glob(glob).scanSync({ cwd: ROOT, dot: true }))
    if (!f.startsWith("node_modules/")) return true;
  return false;
};
// lwp-* rules are vendored from the house standard and owned there.
const OWN_RULES = readdirSync(join(ROOT, ".claude/rules")).filter((f) => f.endsWith(".md") && !f.startsWith("lwp-"));

// Backticked repo paths: `src/x.ts`, `template/`, `install.sh`. Commands and globs are skipped.
function pathsIn(text: string): string[] {
  return [...text.matchAll(/`([\w.-]+\/[\w./-]*|[\w-]+\.(?:ts|md|sh|json))`/g)].map((m) => m[1]!);
}

test("CLAUDE.md imports AGENTS.md and says what to keep on compaction", () => {
  const text = read("CLAUDE.md");
  expect(text.split("\n")[0]).toBe("@AGENTS.md");
  expect(text).toContain("# Compact instructions");
});

test("AGENTS.md is short and every path it names exists", () => {
  const text = read("AGENTS.md");
  expect(text.split("\n").length).toBeLessThan(120);
  expect(pathsIn(text).length).toBeGreaterThan(10);
  expect(pathsIn(text).filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
});

test("every rule scopes itself to paths that match a file, and names only real paths", () => {
  expect(OWN_RULES.length).toBeGreaterThan(0);
  for (const rule of OWN_RULES) {
    const text = read(`.claude/rules/${rule}`);
    const globs = [...(/^---\npaths:\n((?: {2}- .+\n)+)---/.exec(text)?.[1] ?? "").matchAll(/- "(.+)"/g)].map(
      (m) => m[1]!,
    );
    expect(globs.length, rule).toBeGreaterThan(0);
    for (const g of globs) expect(matchesAFile(g), `${rule}: ${g}`).toBe(true);
    expect(
      pathsIn(text).filter((p) => !existsSync(join(ROOT, p))),
      rule,
    ).toEqual([]);
  }
});

test("settings name their schema and deny secrets, token spend and force-push", () => {
  const s = JSON.parse(read(".claude/settings.json")) as { $schema?: string; permissions: { deny: string[] } };
  expect(s.$schema).toContain("claude-code-settings");
  for (const rule of [
    "Read(./.env*)",
    "Bash(make agent-matrix)",
    "Bash(bun scripts/agent-matrix.ts)",
    "Bash(git push --force *)",
  ])
    expect(s.permissions.deny).toContain(rule);
});

test("CI runs the gate with an empty HOME, so nothing passes only on one machine", () => {
  expect(read(".github/workflows/ci.yml")).toContain('HOME="$(mktemp -d)" make check');
});

// relay/target was committed once: clippy run inside the crate builds there, not in CARGO_TARGET_DIR.
test("every Rust crate's build output is ignored", () => {
  const ignored = read(".gitignore").split("\n");
  for (const toml of new Bun.Glob("*/Cargo.toml").scanSync({ cwd: ROOT }))
    expect(ignored).toContain(`${toml.replace("Cargo.toml", "")}target/`);
});
