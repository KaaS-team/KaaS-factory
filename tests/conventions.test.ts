// E13.2: the repo's own style reaches build and verify, and a format diff fails the gate.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalExecution } from "../src/adapters/local/execution";
import { buildContextPack } from "../src/context";
import { detectConventions, diskConventionFiles, renderConventions } from "../src/conventions";
import { parseGateLine, runGates, ShellGateRunner } from "../src/gates";
import type { ExecResult, ExecutionPort } from "../src/ports/execution";

mkdirSync(tmpdir(), { recursive: true });
const made: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-conv-"));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const STYLE_REPO = {
  "package.json": JSON.stringify({ type: "module", devDependencies: { prettier: "3" } }),
  ".prettierrc": '{ "useTabs": true, "singleQuote": true, "semi": false, "printWidth": 100 }',
  "tsconfig.json": "{}",
  "test/a.spec.ts": "",
  "src/a.ts": "",
};

describe("detectConventions", () => {
  test("reads the formatter, linter and type checker a repo configures", () => {
    const dir = repo({ ...STYLE_REPO, "eslint.config.js": "export default []" });
    const roles = detectConventions(diskConventionFiles(dir)).tools.map((t) => `${t.role}:${t.name}`);
    expect(roles).toEqual(["format:prettier", "lint:eslint", "typecheck:tsc"]);
  });

  test("states a non-default style and the test layout", () => {
    const text = renderConventions(detectConventions(diskConventionFiles(repo(STYLE_REPO))));
    expect(text).toContain("Indent with tabs.");
    expect(text).toContain("single quotes");
    expect(text).toContain("Omit semicolons");
    expect(text).toContain("Tests live in `test/`.");
    expect(text).toContain("*.spec.<ext>");
  });

  test("a repo with no tooling renders nothing", () => {
    expect(renderConventions(detectConventions(diskConventionFiles(repo({ "README.md": "x" }))))).toBe("");
  });
});

describe("context pack", () => {
  for (const stage of ["build", "verify"] as const) {
    test(`${stage} receives the conventions profile`, async () => {
      const pack = await buildContextPack(stage, 1, repo(STYLE_REPO));
      expect(pack).toContain("detected conventions");
      expect(pack).toContain("Indent with tabs.");
    });
  }

  test("plan does not", async () => {
    expect(await buildContextPack("plan", 1, repo(STYLE_REPO))).toBe("");
  });
});

const GREEN = "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-";

function fakeExec(formatCode: number, seen: string[]): ExecutionPort {
  return {
    async run(cmd): Promise<ExecResult> {
      seen.push(cmd);
      if (cmd.includes("bash .factory/gates.sh")) return { stdout: GREEN, stderr: "", code: 0 };
      if (cmd.includes("git diff --name-only")) return { stdout: "src/a.ts\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "would reformat", code: formatCode };
    },
  };
}

function gateRepo(extra: Record<string, string> = {}): string {
  return repo({
    ...STYLE_REPO,
    ...extra,
    ".factory/config.json": JSON.stringify({
      base: "main",
      gates: [{ name: "test", cmd: "true", required: true, role: "test" }],
    }),
  });
}

describe("format-diff gate", () => {
  test("a format diff turns a green run red and names the gate", async () => {
    const seen: string[] = [];
    const result = await runGates(new ShellGateRunner(fakeExec(1, seen)), gateRepo());
    expect(result.status).toBe("RED");
    expect(result.failedGates).toContain("format");
    expect(seen.some((c) => c.includes("prettier") && c.includes("'src/a.ts'"))).toBe(true);
  });

  test("a clean format check stays green and counts as passed", async () => {
    const result = await runGates(new ShellGateRunner(fakeExec(0, [])), gateRepo());
    expect(result.status).toBe("GREEN");
    expect(result.passed).toBeGreaterThan(1);
  });

  test("a tool that is not installed does not fail the build", async () => {
    const result = await runGates(new ShellGateRunner(fakeExec(127, [])), gateRepo());
    expect(result.status).toBe("GREEN");
  });

  test("a repo whose config already has a format gate is not checked twice", async () => {
    const dir = repo({
      ...STYLE_REPO,
      ".factory/config.json": JSON.stringify({ gates: [{ name: "fmt", cmd: "true", required: true, role: "format" }] }),
    });
    const seen: string[] = [];
    await runGates(new ShellGateRunner(fakeExec(1, seen)), dir);
    expect(seen.some((c) => c.includes("prettier"))).toBe(false);
  });

  test("with no changed files to format, nothing runs", async () => {
    const seen: string[] = [];
    const exec: ExecutionPort = {
      async run(cmd) {
        seen.push(cmd);
        return cmd.includes("gates.sh") ? { stdout: GREEN, stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 };
      },
    };
    const result = await runGates(new ShellGateRunner(exec), gateRepo());
    expect(result.status).toBe("GREEN");
  });
});

// The repo's own formatter, for real: a change in the repo's tab style passes, a spaces one fails.
const BIOME = resolve(import.meta.dir, "../node_modules/.bin/biome");
describe("a repo with a non-default style, checked by its own formatter", () => {
  function biomeRepo(source: string): string {
    const dir = repo({
      "package.json": "{}",
      "biome.json": JSON.stringify({
        formatter: { indentStyle: "tab" },
        javascript: { formatter: { quoteStyle: "single" } },
      }),
      "src/a.ts": source,
      ".gitignore": "/*\n!/src\n",
      ".factory/config.json": JSON.stringify({
        base: "main",
        gates: [{ name: "test", cmd: "true", required: true, role: "test" }],
      }),
    });
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    symlinkSync(BIOME, join(dir, "node_modules/.bin/biome"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir, timeout: 20000 });
    return dir;
  }
  const exec = (dir: string): ExecutionPort => {
    const local = new LocalExecution();
    return {
      run: (cmd, cwd) =>
        cmd.includes("gates.sh") ? Promise.resolve({ stdout: GREEN, stderr: "", code: 0 }) : local.run(cmd, cwd ?? dir),
    };
  };

  test("a change in the repo's style passes", async () => {
    const dir = biomeRepo("export function f() {\n\treturn 'a'\n}\n".replace("'a'", "'a';"));
    const r = await runGates(new ShellGateRunner(exec(dir)), dir);
    expect(r.status).toBe("GREEN");
  });

  test("a change in the default style fails", async () => {
    const dir = biomeRepo('export function f() {\n  return "a";\n}\n');
    const result = await runGates(new ShellGateRunner(exec(dir)), dir);
    expect(result.status).toBe("RED");
    expect(result.failedGates).toContain("format");
  });
});

test("parseGateLine still reads the folded line", () => {
  expect(
    parseGateLine("FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=format")?.failedGates,
  ).toEqual(["format"]);
});
