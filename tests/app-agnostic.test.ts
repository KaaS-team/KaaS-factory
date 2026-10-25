// The factory must work on any repo, not just the demo app. Two checks: runtime
// code never names the demo app, and a Python repo on a `trunk` branch (no repo
// key, no Makefile, no bun) loads, gates and refuses a wrong origin.

import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadConfig, repoFromRemoteUrl } from "../src/config";
import { parseGateLine } from "../src/gates";
import { defaultStatePath, workspacesDir, worktreePath } from "../src/paths";

const ROOT = join(import.meta.dir, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("runtime code does not name the demo app", () => {
  // A comment may say where a fact was found; a string or identifier may not depend on it.
  const APP = /splitbill|learnwithparam\/(?!software-factory)/i;
  const files = ["src", "bin", "template", "dashboard", "scripts"]
    .flatMap((d) => walk(join(ROOT, d)))
    .concat(join(ROOT, "install.sh"));

  test("every mention is on a comment line", () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (APP.test(line) && !/^\s*(\/\/|#|\*|<!--)/.test(line))
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

// The stage skills and agents run against any repo's own gate and its own
// stack (plan v2.7.0 item 8: `proof: check` exists so a Markdown-only repo
// never needs a test runner at all). A skill that names a stack tool by name
// smuggles an assumption back in, so this greps the exact same files an agent
// reads at runtime, not the whole template/ tree (gates.sh and the CI
// workflow are allowed to be Bun/npm-specific; they say so).
describe("stage skills and agents name no stack tool", () => {
  const STACK_TOOL = /\bnpm\b|\bbun\b|\bpytest\b|\bcargo\b|\bgo test\b/i;
  const dirs = ["template/.claude/skills", "template/.claude/agents"];
  const files = dirs.flatMap((d) => walk(join(ROOT, d)));

  test("no skill or agent file names npm, bun, pytest, cargo or go test", () => {
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (STACK_TOOL.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("remote URLs", () => {
  test("github https and ssh forms give owner/name; anything else is not judged", () => {
    expect(repoFromRemoteUrl("https://github.com/acme/pyapp.git\n")).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("https://github.com/acme/pyapp")).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("https://x-access-token@github.com/acme/pyapp.git")).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("git@github.com:acme/pyapp.git")).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("/tmp/some/bare.git")).toBeUndefined();
    expect(repoFromRemoteUrl("https://gitlab.com/acme/pyapp.git")).toBeUndefined();
  });

  test("a GitHub Enterprise remote parses when GH_HOST names its host, and only then", () => {
    const ghe = { GH_HOST: "ghe.acme.io" };
    expect(repoFromRemoteUrl("https://ghe.acme.io/acme/pyapp.git", ghe)).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("git@ghe.acme.io:acme/pyapp.git", ghe)).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("ssh://git@ghe.acme.io/acme/pyapp", ghe)).toBe("acme/pyapp");
    expect(repoFromRemoteUrl("https://gheXacme.io/acme/pyapp.git", ghe)).toBeUndefined();
    expect(repoFromRemoteUrl("https://ghe.acme.io/acme/pyapp.git", {})).toBeUndefined();
    expect(repoFromRemoteUrl("https://github.com/acme/pyapp.git", ghe)).toBeUndefined();
  });
});

describe("a Python repo on a trunk branch", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-agnostic-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function git(cwd: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }

  function pyRepo(config: object): string {
    const dir = mkdtempSync(join(root, "py-"));
    git(dir, "init", "-q", "-b", "trunk");
    git(dir, "remote", "add", "origin", "https://github.com/acme/pyapp.git");
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory/config.json"), JSON.stringify(config));
    copyFileSync(join(ROOT, "template/.factory/gates.sh"), join(dir, ".factory/gates.sh"));
    mkdirSync(join(dir, "tests"));
    writeFileSync(
      join(dir, "tests/test_math.py"),
      "import unittest\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n",
    );
    return dir;
  }

  const gates = [{ name: "unit", cmd: "python3 -B -m unittest discover -s tests", required: true }];

  function runGatesSh(dir: string): string {
    const r = Bun.spawnSync(["bash", ".factory/gates.sh"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return parseGateLine(r.stdout.toString() + r.stderr.toString())?.status ?? "no-line";
  }

  test("the repo comes from origin when the config omits it", async () => {
    const config = await loadConfig(pyRepo({ base: "trunk", gates }));
    expect(config.repo).toBe("acme/pyapp");
    expect(config.base).toBe("trunk");
  });

  test("a config that names a different repo than origin is refused", async () => {
    await expect(loadConfig(pyRepo({ repo: "acme/other", gates }))).rejects.toThrow(
      /"repo" is acme\/other but this clone's origin is acme\/pyapp/,
    );
  });

  test("a matching repo passes, ignoring case", async () => {
    expect((await loadConfig(pyRepo({ repo: "Acme/PyApp", gates }))).repo).toBe("Acme/PyApp");
  });

  test("the template gate runner is GREEN on a passing test and RED once it breaks", () => {
    if (!Bun.which("jq")) return; // gates.sh needs jq, which `factory doctor` also requires
    const dir = pyRepo({ base: "trunk", gates });
    expect(runGatesSh(dir)).toBe("GREEN");
    writeFileSync(
      join(dir, "tests/test_math.py"),
      "import unittest\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 3)\n",
    );
    expect(runGatesSh(dir)).toBe("RED");
  });
});

// The other half of "any repo, safely" (plan v2.6.2 item 1): a second repo
// sharing one FACTORY_HOME must never share a worktree or a state DB with
// the first, even when both hold the same issue number.
describe("two repos sharing one FACTORY_HOME never collide", () => {
  const env = { HOME: "/tmp/does-not-matter", FACTORY_HOME: "/tmp/factory-home-shared" } as NodeJS.ProcessEnv;

  test("workspaces and state DBs are namespaced by owner/name", () => {
    const a = { workspaces: workspacesDir(env, "acme/pyapp"), db: defaultStatePath(env, "acme/pyapp") };
    const b = { workspaces: workspacesDir(env, "acme/other"), db: defaultStatePath(env, "acme/other") };
    expect(a.workspaces).not.toBe(b.workspaces);
    expect(a.db).not.toBe(b.db);
    expect(a.workspaces.startsWith("/tmp/factory-home-shared/acme/pyapp")).toBe(true);
    expect(b.workspaces.startsWith("/tmp/factory-home-shared/acme/other")).toBe(true);
  });

  test("the same issue number in two repos never resolves to the same worktree", () => {
    const a = worktreePath(3, env, "acme/pyapp");
    const b = worktreePath(3, env, "acme/other");
    expect(a).not.toBe(b);
    expect(a.endsWith("/issue-3")).toBe(true);
    expect(b.endsWith("/issue-3")).toBe(true);
  });

  test("omitting repo keeps the pre-v2.6.2 shared path, so an unmigrated single-repo install is unaffected", () => {
    expect(workspacesDir(env)).toBe(`${env.FACTORY_HOME}/workspaces`);
    expect(defaultStatePath(env)).toBe(`${env.FACTORY_HOME}/factory.db`);
  });

  test("a repo slug with no slash refuses instead of silently sharing a path", () => {
    expect(() => workspacesDir(env, "not-a-slug")).toThrow(/repo must be "owner\/name"/);
  });

  test("a repo from a URL query cannot climb out of FACTORY_HOME", () => {
    for (const bad of ["../..", "a/..", "./b", "a/b/c", "a/b%2f..", "a/ b"])
      expect(() => workspacesDir(env, bad)).toThrow(/repo must be/);
    expect(workspacesDir(env, "learnwithparam/claude-verification-harness")).toEndWith(
      "/claude-verification-harness/workspaces",
    );
  });
});
