// The runner grades the build, not the agent (audit finding #11): this is
// what makes `FACTORY_GATES:` authoritative — the one line runGates trusts,
// parsed the same way whether it shows up on stdout, buried in noisier
// stderr output, or missing entirely (a misconfigured target's gates.sh).

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseGateLine, runGates, ShellGateRunner, type GateRunner } from "../src/gates";
import { LocalExecution } from "../src/adapters/local/execution";
import type { ExecResult, ExecutionPort } from "../src/ports/execution";

describe("parseGateLine", () => {
  test("parses a well-formed GREEN line", () => {
    const result = parseGateLine(
      "some noise\nFACTORY_GATES: status=GREEN passed=12 failed=0 skipped=1 failed_gates=-\nmore noise",
    );
    expect(result).toEqual({
      status: "GREEN",
      passed: 12,
      failed: 0,
      skipped: 1,
      failedGates: [],
      raw: "FACTORY_GATES: status=GREEN passed=12 failed=0 skipped=1 failed_gates=-",
    });
  });

  test("parses a RED line with named failed gates", () => {
    const result = parseGateLine("FACTORY_GATES: status=RED passed=8 failed=2 skipped=0 failed_gates=lint,typecheck");
    expect(result?.status).toBe("RED");
    expect(result?.failedGates).toEqual(["lint", "typecheck"]);
  });

  test("returns undefined when the line is missing entirely", () => {
    expect(parseGateLine("make check\nall good, no summary line printed")).toBeUndefined();
  });

  test("is case-insensitive on status but normalizes to uppercase", () => {
    const result = parseGateLine("FACTORY_GATES: status=green passed=1 failed=0 skipped=0 failed_gates=-");
    expect(result?.status).toBe("GREEN");
  });
});

// Records the command line it is asked to run, instead of running it.
class RecordingPort implements ExecutionPort {
  readonly cmds: string[] = [];
  async run(cmd: string, _cwd: string): Promise<ExecResult> {
    this.cmds.push(cmd);
    return { stdout: "", stderr: "", code: 0 };
  }
}

describe("ShellGateRunner setup", () => {
  const setup = ["bun install --frozen-lockfile"];

  test("a remote runtime installs deps in the same directory before the gates", async () => {
    const remote = new RecordingPort();
    await new ShellGateRunner(remote, setup).run("/tmp/whatever");
    expect(remote.cmds).toEqual(["bun install --frozen-lockfile && bash .factory/gates.sh"]);
  });

  test("a local runtime runs the bare gate command, with no setup", async () => {
    const local = new (class extends LocalExecution {
      readonly cmds: string[] = [];
      override async run(cmd: string, _cwd: string): Promise<ExecResult> {
        this.cmds.push(cmd);
        return { stdout: "", stderr: "", code: 0 };
      }
    })();
    await new ShellGateRunner(local, setup).run("/tmp/whatever");
    expect(local.cmds).toEqual(["bash .factory/gates.sh"]);
  });
});

class FixedGateRunner implements GateRunner {
  constructor(private readonly result: { stdout: string; stderr: string; code: number }) {}
  async run(_worktreeDir: string) {
    return this.result;
  }
}

describe("runGates", () => {
  test("returns the parsed result when gates.sh prints the line", async () => {
    const runner = new FixedGateRunner({
      stdout: "FACTORY_GATES: status=GREEN passed=5 failed=0 skipped=0 failed_gates=-",
      stderr: "",
      code: 0,
    });
    const result = await runGates(runner, "/tmp/whatever");
    expect(result.status).toBe("GREEN");
  });

  test("falls back to MISCONFIGURED, not GREEN, when no line is printed", async () => {
    const runner = new FixedGateRunner({ stdout: "gates.sh: command not found", stderr: "", code: 127 });
    const result = await runGates(runner, "/tmp/whatever");
    expect(result.status).toBe("MISCONFIGURED");
    expect(result.failedGates).toContain("gates.sh produced no FACTORY_GATES line");
  });

  test("reads the line from stderr too, not only stdout", async () => {
    const runner = new FixedGateRunner({
      stdout: "",
      stderr: "FACTORY_GATES: status=RED passed=3 failed=1 skipped=0 failed_gates=make-check",
      code: 1,
    });
    const result = await runGates(runner, "/tmp/whatever");
    expect(result.status).toBe("RED");
    expect(result.failedGates).toEqual(["make-check"]);
  });
});

// Monorepo: the shipped gates.sh on a two-package fixture. Each gate writes a
// marker file, so the test sees which packages ran, not only the summary line.
describe("gates.sh packages", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const root = resolve(import.meta.dir, "..");
  const git = (dir: string, ...args: string[]) =>
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });

  // A main commit (with the seed files), then a branch that adds the touch files.
  function repo(touch: string[], seed: string[] = []): string {
    const dir = mkdtempSync(join(tmpdir(), "gates-mono-"));
    dirs.push(dir);
    cpSync(join(root, "tests", "fixtures", "monorepo"), dir, { recursive: true });
    cpSync(join(root, "template", ".factory", "gates.sh"), join(dir, ".factory", "gates.sh"));
    for (const file of seed) writeFileSync(join(dir, file), "");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-qb", "feature");
    for (const file of touch) writeFileSync(join(dir, file), "x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "change");
    return dir;
  }
  const gates = (dir: string, base = "main") => {
    const r = Bun.spawnSync(["bash", ".factory/gates.sh"], {
      cwd: dir,
      stdout: "pipe",
      env: { ...process.env, FACTORY_GATES_BASE: base },
    });
    return { out: r.stdout.toString(), ran: ["api", "web", "shared"].filter((p) => existsSync(join(dir, `${p}.ran`))) };
  };

  test("only the touched package runs, plus top-level gates and always packages", () => {
    const { out, ran } = gates(repo(["packages/api/change.txt"]));
    expect(ran).toEqual(["api", "shared"]);
    expect(out).toContain("package packages/web: untouched");
    expect(out).toContain("FACTORY_GATES: status=GREEN passed=3 failed=0 skipped=0");
  });

  test("an untouched package's broken gate does not fail the build", () => {
    expect(gates(repo(["packages/api/change.txt"], ["packages/web/broken"])).out).toContain("status=GREEN");
  });

  test("an uncommitted change in a package counts as touching it", () => {
    const dir = repo(["packages/api/change.txt"], ["packages/web/broken"]);
    writeFileSync(join(dir, "packages", "web", "edit.txt"), "");
    expect(gates(dir).out).toContain("failed_gates=packages/web:test");
  });

  test("a touched package's failing gate is named with its path", () => {
    const { out, ran } = gates(repo(["packages/web/broken"]));
    expect(ran).toEqual(["web", "shared"]);
    expect(out).toContain("FACTORY_GATES: status=RED passed=2 failed=1 skipped=0 failed_gates=packages/web:test");
  });

  test("no base to diff against, or a diff that touches no package: every package runs", () => {
    expect(gates(repo(["packages/api/change.txt"]), "no-such-ref").ran).toEqual(["api", "web", "shared"]);
    expect(gates(repo(["notes.md"])).ran).toEqual(["api", "web", "shared"]);
  });
});
