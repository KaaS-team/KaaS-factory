import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliSurface, openapiSurface, removals } from "../scripts/check-contract-diff";

const SCRIPT = resolve(import.meta.dir, "../scripts/check-contract-diff.ts");

const spec = (paths: Record<string, unknown>): string => JSON.stringify({ openapi: "3.1.0", paths });
const op = (props: string[]): unknown => ({
  responses: {
    "200": {
      content: {
        "application/json": {
          schema: { type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])) },
        },
      },
    },
  },
});
const gone = (a: string, b: string): string[] => removals(openapiSurface(a), openapiSurface(b));

describe("openapi surface", () => {
  const base = spec({ "/a": { get: op(["x"]), post: op([]) }, "/b": { get: op([]) } });

  test("removing a path or a method is reported", () => {
    expect(gone(base, spec({ "/a": { get: op(["x"]), post: op([]) } }))).toEqual(["GET /b"]);
    expect(gone(base, spec({ "/a": { get: op(["x"]) }, "/b": { get: op([]) } }))).toEqual(["POST /a"]);
  });

  test("adding a path is not reported", () => {
    expect(
      gone(base, spec({ "/a": { get: op(["x"]), post: op([]) }, "/b": { get: op([]) }, "/c": { get: op([]) } })),
    ).toEqual([]);
  });

  test("removing a response property is reported, adding one is not", () => {
    expect(gone(spec({ "/a": { get: op(["x", "y"]) } }), spec({ "/a": { get: op(["x"]) } }))).toEqual([
      "GET /a 200 application/json.y",
    ]);
    expect(gone(spec({ "/a": { get: op(["x"]) } }), spec({ "/a": { get: op(["x", "y"]) } }))).toEqual([]);
  });

  test("a rename is one removal plus one addition", () => {
    const before = spec({ "/old": { get: op([]) } });
    const after = spec({ "/new": { get: op([]) } });
    expect(gone(before, after)).toEqual(["GET /old"]);
    expect(gone(after, before)).toEqual(["GET /new"]);
  });
});

describe("cli surface", () => {
  const md = (rows: string[]): string =>
    [
      "## Commands",
      "",
      "### up",
      "",
      "```",
      "factory up [--tmux] [--repo <r>]",
      "```",
      "",
      "### watch",
      "",
      "```",
      "factory watch",
      "```",
      "",
      "## Options",
      "",
      ...rows,
    ].join("\n");
  const rows = ["- `--db <path>`: cache", "- `-h, --help`: help"];

  test("lists commands, per-command flags and global options", () => {
    expect(cliSurface(md(rows))).toEqual([
      "command up",
      "command watch",
      "option --db",
      "option --help",
      "option -h",
      "up --repo",
      "up --tmux",
    ]);
  });

  test("removing an option row is reported", () => {
    expect(removals(cliSurface(md(rows)), cliSurface(md(rows.slice(1))))).toEqual(["option --db"]);
  });

  test("removing a command flag is reported", () => {
    const head = md(rows).replace(" [--tmux]", "");
    expect(removals(cliSurface(md(rows)), cliSurface(head))).toEqual(["up --tmux"]);
  });
});

describe("cli", () => {
  const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["bun", SCRIPT, ...args], { timeout: 60_000, cwd });
  const git = (cwd: string, ...args: string[]) =>
    Bun.spawnSync(
      ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { timeout: 60_000, cwd },
    );

  function repo(withBase: boolean): string {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "contract-diff-"));
    mkdirSync(join(dir, "src/api"), { recursive: true });
    git(dir, "init", "-q");
    if (withBase) {
      writeFileSync(join(dir, "src/api/openapi.json"), spec({ "/a": { get: op([]) }, "/b": { get: op([]) } }));
      git(dir, "add", "src/api/openapi.json");
      git(dir, "commit", "-q", "-m", "base");
    } else {
      writeFileSync(join(dir, "README"), "x");
      git(dir, "add", "README");
      git(dir, "commit", "-q", "-m", "base");
    }
    writeFileSync(join(dir, "src/api/openapi.json"), spec({ "/a": { get: op([]) } }));
    return dir;
  }

  test("a removal prints and exits 1; --allow-breaking prints and exits 0", () => {
    const dir = repo(true);
    const r = run(dir, "HEAD");
    expect(r.exitCode).toBe(1);
    expect(r.stdout.toString()).toContain("removed GET /b");
    const ok = run(dir, "HEAD", "--allow-breaking");
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString()).toContain("removed GET /b");
  });

  test("a file missing at the base ref reports nothing", () => {
    const r = run(repo(false), "HEAD");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
  });
});
