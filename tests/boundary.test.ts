// Defense in depth behind guard-paths.sh (audit finding #12): that hook only
// sees Edit/Write tool calls, so `Bash("sed -i ... src/auth/x.ts")` never
// trips it. This is the independent check the runner makes before any push,
// by diffing the branch against its base rather than trusting how a file
// changed.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALWAYS_PROTECTED_PATHS, touchesProtectedPath } from "../src/boundary";
import { autoEligible } from "../src/merge-policy";

describe("touchesProtectedPath", () => {
  test("flags an exact-path match", () => {
    expect(touchesProtectedPath(["src/auth/session.ts"], ["src/auth/session.ts"])).toEqual(["src/auth/session.ts"]);
  });

  test("flags a file under a glob, matching what a Bash-made edit would still hit", () => {
    const changed = ["src/auth/tokens.ts", "src/ui/button.tsx"];
    expect(touchesProtectedPath(changed, ["src/auth/**"])).toEqual(["src/auth/tokens.ts"]);
  });

  test("returns no hits when nothing changed touches a protected path", () => {
    expect(touchesProtectedPath(["src/ui/button.tsx", "README.md"], ["src/auth/**", ".env*"])).toEqual([]);
  });

  test("returns no hits when protectedPaths is empty", () => {
    expect(touchesProtectedPath(["anything.ts"], [])).toEqual([]);
  });

  test("collects every offending file, not just the first", () => {
    const changed = ["src/auth/a.ts", "src/ui/b.ts", "src/auth/c.ts"];
    expect(touchesProtectedPath(changed, ["src/auth/**"])).toEqual(["src/auth/a.ts", "src/auth/c.ts"]);
  });

  test("matches a dotfile pattern like a secrets file", () => {
    expect(touchesProtectedPath([".env.production"], [".env*"])).toEqual([".env.production"]);
  });

  // touchesProtectedPath merges ALWAYS_PROTECTED_PATHS itself (one resolver,
  // not a spread every caller must remember), so .claude/** and .factory/**
  // are refused for every caller even with the default empty protectedPaths
  // config, matching what guard-paths.sh already hardcodes. This covers both
  // call sites at once: src/watch.ts's build-stage push check and
  // src/merge-policy.ts's autoEligible.
  test("ALWAYS_PROTECTED_PATHS flags .claude/** and .factory/** with no repo config at all", () => {
    const changed = [".claude/skills/factory-build/SKILL.md", ".factory/memory/lessons.md", "src/ui/button.tsx"];
    expect(touchesProtectedPath(changed, [])).toEqual([
      ".claude/skills/factory-build/SKILL.md",
      ".factory/memory/lessons.md",
    ]);
  });

  // The hook and the push check refuse the same paths: one list, pinned here, not two kept by hand.
  test("guard-paths.sh hardcodes exactly ALWAYS_PROTECTED_PATHS", () => {
    const hook = readFileSync(join(import.meta.dir, "../template/.claude/hooks/guard-paths.sh"), "utf8");
    const line = /^globs \+= (\[.*\])$/m.exec(hook)?.[1];
    expect(line && JSON.parse(line)).toEqual([...ALWAYS_PROTECTED_PATHS]);
    expect(touchesProtectedPath([".agents/skills/factory-verify/SKILL.md"], [])).toEqual([
      ".agents/skills/factory-verify/SKILL.md",
    ]);
  });

  // Explicitly passing ALWAYS_PROTECTED_PATHS too (as a caller migrating from
  // the old caller-side merge might still do) must not double-count a hit.
  test("passing ALWAYS_PROTECTED_PATHS explicitly alongside the built-in merge does not duplicate hits", () => {
    expect(touchesProtectedPath([".claude/x.md"], [...ALWAYS_PROTECTED_PATHS])).toEqual([".claude/x.md"]);
  });

  // The second call site (src/merge-policy.ts's autoEligible, used by the
  // "auto" merge policy) gets the same hardening for free because it goes
  // through touchesProtectedPath, not a separate check. Proven end to end,
  // not just against the shared helper in isolation.
  test("a PR touching .claude/** is never auto-eligible, even with an empty repo protectedPaths config", () => {
    const refusals = autoEligible(
      "low",
      [{ path: ".claude/skills/factory-build/SKILL.md", additions: 1, deletions: 0 }],
      { autoPaths: [".claude/**"], maxFiles: 10, maxLines: 200 },
      [],
    );
    expect(refusals.map((r) => r.reason)).toContain("not-auto-eligible");
  });
});

// gate.py's shape checks, against what git diff --raw/--numstat reports (src/git.ts diffStat).
describe("autoEligible refuses a file whose shape its path and line limits cannot judge", () => {
  const merge = { autoPaths: ["**"], maxFiles: 10, maxLines: 200 };
  const details = (files: Parameters<typeof autoEligible>[1]) =>
    autoEligible("low", files, merge, []).map((r) => r.detail);

  test("plain and deleted files pass", () => {
    expect(
      details([
        { path: "a.md", additions: 1, deletions: 0, mode: "100644" },
        { path: "b.md", additions: 0, deletions: 3, mode: "000000" },
      ]),
    ).toEqual([]);
  });

  test("an executable, a symlink or a submodule is refused by name", () => {
    for (const mode of ["100755", "120000", "160000"]) {
      expect(details([{ path: "x", additions: 1, deletions: 0, mode }])).toEqual([
        `not a plain file (mode): x (${mode})`,
      ]);
    }
  });

  test("a binary file is refused, since numstat counts no lines for it", () => {
    expect(details([{ path: "logo.png", additions: 0, deletions: 0, mode: "100644", binary: true }])).toEqual([
      "binary, so its size is unknown: logo.png",
    ]);
  });

  test("a rename out of a protected path is caught on its old side", () => {
    const refusals = autoEligible(
      "low",
      [
        { path: "secrets/k.txt", additions: 0, deletions: 1, mode: "000000" },
        { path: "docs/k.txt", additions: 1, deletions: 0, mode: "100644" },
      ],
      merge,
      ["secrets/**"],
    );
    expect(refusals.map((r) => r.detail)).toEqual(["protected path(s): secrets/k.txt"]);
  });
});
