// Case-insensitive protected paths, and the greenfield scaffold exception for build scripts
// (issues #161, #153). The caller under test is the build step in src/engine/steps.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touchesProtectedPath } from "../src/boundary";
import { mergeConfig } from "../src/config";
import type { StageName, StageRunResult } from "../src/executor";
import { BUILD_SCRIPT_GLOBS, withBuildScriptsProtected } from "../src/init-guard";
import { LABEL } from "../src/labels";
import { FactoryState } from "../src/state";
import { advanceIssue } from "../src/watch";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

describe("touchesProtectedPath ignores case", () => {
  test("an upper-case directory matches a lower-case glob", () => {
    expect(touchesProtectedPath(["SRC/payments/x.ts"], ["src/payments/**"])).toEqual(["SRC/payments/x.ts"]);
  });

  test("a mixed-case file name matches", () => {
    expect(touchesProtectedPath(["src/Payments/X.ts", "src/other.ts"], ["src/payments/x.ts"])).toEqual([
      "src/Payments/X.ts",
    ]);
  });

  test("a lower-case makefile matches the Makefile glob, and an upper-case glob matches lower-case paths", () => {
    expect(touchesProtectedPath(["makefile"], ["Makefile"])).toEqual(["makefile"]);
    expect(touchesProtectedPath([".CLAUDE/settings.json", ".Agents/x.md"], [])).toEqual([
      ".CLAUDE/settings.json",
      ".Agents/x.md",
    ]);
    expect(touchesProtectedPath(["src/ui/a.ts"], ["SRC/PAYMENTS/**"])).toEqual([]);
  });
});

describe("touchesProtectedPath baseFiles option", () => {
  const globs = withBuildScriptsProtected({ protectedPaths: ["src/pay/**"] }).protectedPaths;
  const changed = ["Makefile", "rules.mk", "src/pay/a.ts", ".claude/x.md"];

  test("a base tree with no build script exempts build scripts only, never another protected path", () => {
    expect(touchesProtectedPath(changed, globs, { baseFiles: ["README.md"] })).toEqual([
      "src/pay/a.ts",
      ".claude/x.md",
    ]);
    expect(touchesProtectedPath(changed, globs, { baseFiles: [] })).toEqual(["src/pay/a.ts", ".claude/x.md"]);
  });

  test("a base tree with a build script, at any depth or case, keeps them protected", () => {
    for (const baseFiles of [["Makefile"], ["tools/GNUMAKEFILE"], ["a/b/rules.mk"]]) {
      expect(touchesProtectedPath(changed, globs, { baseFiles })).toEqual(changed);
    }
  });

  test("omitting baseFiles keeps build scripts protected", () => {
    expect(touchesProtectedPath(["Makefile"], globs)).toEqual(["Makefile"]);
  });
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function setup(baseTree: string[], changed: string[]) {
  mkdirSync(tmpdir(), { recursive: true });
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-scaffold-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-scaffold-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const n = 1;
  const github = new FakeGitHub([baseIssue(n, [LABEL.ready])]);
  const git = new FakeGit();
  git.baseTree = baseTree;
  git.changed = changed;
  const state = new FactoryState(":memory:");
  const executor = new MultiStageExecutor();
  const config = mergeConfig({ repo: "acme/widgets", protectedPaths: [...BUILD_SCRIPT_GLOBS] });
  const deps = {
    github,
    git,
    state,
    executor,
    gateRunner: new FakeGateRunner(),
    holdoutRunner: new FakeHoldoutRunner(),
    cloneDir,
    workspacesDir,
  };
  const push = (stage: StageName, files: Record<string, string>, result?: Partial<StageRunResult>) =>
    executor.push(stage, n, fixtureFor(stage, n), files, result);
  push("triage", {
    "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
    "triage.json": JSON.stringify({
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: ["src/a.ts"],
      gate_level: "make check",
      confidence: 0.9,
    }),
  });
  push("plan", {
    "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
    "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true }),
  });
  push("build", {
    "status-comment.md": "<!-- factory:status v1 -->\nbuilding",
    "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }),
  });
  push("verify", {
    "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
    "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }),
  });
  push("pr", { "pr-body.md": "Did it.\nRefs #1" });
  state.setToggle("auto_approve_low_risk", true);
  return { n, git, state, step: () => advanceIssue(deps, config, github.issues.get(n)!) };
}

describe("the build step and a Makefile", () => {
  test("a greenfield repo (no build script at base) may add its first Makefile", async () => {
    const c = setup(["README.md"], ["Makefile", "src/a.ts"]);
    expect(await c.step()).toBe("shipped");
    expect(c.git.pushed.length).toBe(1);
  });

  test("editing an existing Makefile is still refused and parks before any push", async () => {
    const c = setup(["README.md", "Makefile"], ["Makefile"]);
    expect(await c.step()).toBe("needs-human");
    expect(c.git.pushed).toEqual([]);
    expect(c.state.getRun("acme/widgets", c.n)!.reason).toBe("touched protected path(s): Makefile");
  });

  test("a scaffold still cannot touch .claude/**", async () => {
    const c = setup(["README.md"], ["Makefile", ".claude/settings.json"]);
    expect(await c.step()).toBe("needs-human");
    expect(c.state.getRun("acme/widgets", c.n)!.reason).toBe("touched protected path(s): .claude/settings.json");
  });
});
