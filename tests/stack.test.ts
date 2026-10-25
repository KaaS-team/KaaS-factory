import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectStack, diskFiles } from "../src/stack";
import { configProblems } from "../src/config";
import { isFilledIn } from "../src/init";

const FIXTURES = resolve(import.meta.dir, "fixtures", "stacks");
const stackOf = (name: string) => detectStack(diskFiles(join(FIXTURES, name)));
const gates = (name: string) => stackOf(name).gates.map((g) => `${g.role}: ${g.cmd}`);

describe("detectStack reads each stack's own files", () => {
  test("bun: the package scripts, run with bun", () => {
    expect(gates("bun")).toEqual(["test: bun run test", "typecheck: bun run typecheck", "lint: bun run lint"]);
    expect(stackOf("bun").setup).toEqual(["bun install --frozen-lockfile"]);
    expect(stackOf("bun").commands).toEqual(["bun *", "bunx *"]);
  });

  test("pnpm: the lockfile picks the package manager; CI is named", () => {
    expect(gates("pnpm")).toEqual(["test: pnpm run test", "lint: pnpm run lint", "build: pnpm run build"]);
    expect(stackOf("pnpm").ci).toBe("GitHub Actions");
  });

  test("uv: pytest and ruff from pyproject, run through uv", () => {
    expect(gates("uv")).toEqual(["test: uv run pytest", "lint: uv run ruff check ."]);
    expect(stackOf("uv").setup).toEqual(["uv sync --frozen"]);
  });

  test("go: go test and go vet", () => {
    expect(gates("go")).toEqual(["test: go test ./...", "lint: go vet ./..."]);
  });

  test("rails: bin/rails test, rubocop from the lockfile", () => {
    expect(stackOf("rails").name).toBe("rails");
    expect(gates("rails")).toEqual(["test: bin/rails test", "lint: bundle exec rubocop"]);
  });

  test("no tests: npm's placeholder test script is not a test, so the proof is unavailable", () => {
    expect(gates("no-tests")).toEqual(["lint: npm run lint"]);
    expect(stackOf("no-tests").notes.join("\n")).toContain("proof will be unavailable");
  });

  test("a Makefile check target is the repo's own gate and wins", () => {
    expect(gates("make")).toEqual(["test: make check"]);
    expect(stackOf("make").commands).toContain("make *");
  });

  test("nothing recognisable: no gates, and a note that says what happens", () => {
    expect(stackOf("docs").gates).toEqual([]);
    expect(stackOf("docs").notes.join("\n")).toContain("parks every issue");
  });
});

// End to end on a copy: install the template, write the config, and run the
// repo's own gates.sh, which must go green on what init wrote.
describe("factory init", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const cli = resolve(import.meta.dir, "..", "src", "cli.ts");

  function copy(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), `init-${name}-`));
    dirs.push(dir);
    cpSync(join(FIXTURES, name), dir, { recursive: true });
    for (const argv of [
      ["git", "init", "-q", "-b", "main"],
      ["git", "remote", "add", "origin", "https://github.com/acme/widgets.git"],
    ])
      Bun.spawnSync(argv, { cwd: dir });
    return dir;
  }
  const init = (dir: string, ...extra: string[]) =>
    Bun.spawnSync(["bun", cli, "init", "--repo-dir", dir, ...extra], { stdout: "pipe", stderr: "pipe" });

  for (const name of ["bun", "no-tests"]) {
    test(`${name}: the written config is valid, filled in, and its gates go green`, () => {
      const dir = copy(name);
      const r = init(dir);
      expect(r.exitCode).toBe(0);
      const text = readFileSync(join(dir, ".factory", "config.json"), "utf8");
      const config = JSON.parse(text);
      expect(configProblems(config)).toEqual([]);
      expect(isFilledIn(text)).toBe(true);
      expect(config.repo).toBe("acme/widgets");
      const gate = Bun.spawnSync(["bash", ".factory/gates.sh"], { cwd: dir, stdout: "pipe" });
      expect(gate.stdout.toString()).toContain("FACTORY_GATES: status=GREEN");
      // init and the gate each spawn a process (npm for no-tests); on a loaded CI runner that took ~10s
    }, 30_000);
  }

  test("a filled-in config is left alone unless --force", () => {
    const dir = copy("bun");
    expect(init(dir).exitCode).toBe(0);
    const path = join(dir, ".factory", "config.json");
    const edited = readFileSync(path, "utf8").replace("bun run lint", "bun run lint:strict");
    writeFileSync(path, edited);
    const again = init(dir);
    expect(again.stdout.toString()).toContain("already filled in");
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(init(dir, "--force").exitCode).toBe(0);
    expect(readFileSync(path, "utf8")).toContain('"bun run lint"');
  });

  test("--dry-run prints the config and writes nothing", () => {
    const dir = copy("go");
    const r = init(dir, "--dry-run");
    expect(
      JSON.parse(
        r.stdout
          .toString()
          .split("\n")
          .filter((l) => !l.startsWith("factory init:"))
          .join("\n"),
      ).gates[0].cmd,
    ).toBe("go test ./...");
    expect(existsSync(join(dir, ".factory"))).toBe(false);
  });
});
