// #161: the proof keeps the gate Makefile, and a revert that ran no test is "did-not-run".

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runProof, ShellProofGit } from "../src/proof";
import { isGateFile, ranZeroTests } from "../src/proof-keep";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): void {
  const r = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")}: ${r.stderr}`);
}

function write(dir: string, path: string, body: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), body);
}

function scaffold(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const origin = mkdtempSync(join(tmpdir(), "keep-origin-"));
  mkdirSync(tmpdir(), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "keep-work-"));
  dirs.push(origin, work);
  run(["git", "init", "-q", "--bare", "-b", "main"], origin);
  run(["git", "init", "-q", "-b", "main"], work);
  run(["git", "config", "commit.gpgsign", "false"], work);
  write(work, "src/add.ts", "export const add = (a: number, b: number) => a - b;\n");
  run(["git", "add", "-A"], work);
  run(["git", "commit", "-q", "-m", "base"], work);
  run(["git", "remote", "add", "origin", origin], work);
  run(["git", "push", "-q", "origin", "main"], work);
  run(["git", "checkout", "-q", "-b", "factory/issue-1"], work);
  // The scaffold adds the gate, the test and the source fix together.
  write(work, "src/add.ts", "export const add = (a: number, b: number) => a + b;\n");
  write(work, "tests/add.test.ts", "// asserts add(1, 2) is 3\n");
  write(
    work,
    "Makefile",
    'test:\n\t@grep -q "a + b" src/add.ts && echo "1 pass" || { echo "expected 3, received -1"; exit 1; }\n',
  );
  run(["git", "add", "-A"], work);
  run(["git", "commit", "-q", "-m", "build"], work);
  return work;
}

describe("proof keeps the gate", () => {
  test("a scaffold that adds the Makefile is proven: the tests run and fail once the source is reverted", async () => {
    const work = scaffold();
    const r = await runProof(new ShellProofGit(), work, "main", "test", "make test");
    expect(r.status).toBe("bites");
    expect(r.reverted).toEqual(["src/add.ts"]);
    expect(r.tail).toContain("expected 3");
    expect(readFileSync(join(work, "Makefile"), "utf8")).toContain("grep -q");
  });

  test("a revert that ran no test is did-not-run, not passes-without", async () => {
    const work = scaffold();
    const r = await runProof(new ShellProofGit(), work, "main", "test", "echo '0 pass'");
    expect(r.status).toBe("did-not-run");
  });

  test("gate files and zero-test output are recognised", () => {
    expect(isGateFile("Makefile")).toBe(true);
    expect(isGateFile("pkg/justfile")).toBe(true);
    expect(isGateFile("src/make.ts")).toBe(false);
    expect(ranZeroTests("make: *** No rule to make target 'test'.  Stop.")).toBe(true);
    expect(ranZeroTests("3 pass\n0 fail")).toBe(false);
  });
  test("a lone failing test is a real result, not an empty run", () => {
    expect(ranZeroTests(" 0 pass\n 1 fail\nRan 1 test across 1 file.")).toBe(false);
    expect(ranZeroTests(" 0 pass\n 0 fail\nRan 0 tests across 0 files.")).toBe(true);
  });
});
