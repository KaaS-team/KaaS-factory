import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, failureJson, successJson } from "../src/cli-output";
import { ConfigError } from "../src/config";

const bin = join(import.meta.dir, "..", "bin", "factory");
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function factory(...args: string[]) {
  const proc = Bun.spawn(["bun", bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code };
}

function repoDir(config?: object): string {
  const d = mkdtempSync(join(dir, "r-"));
  if (config) {
    mkdirSync(join(d, ".factory"));
    writeFileSync(join(d, ".factory/config.json"), JSON.stringify(config));
  }
  return d;
}

describe("--json contract", () => {
  test("envelopes", () => {
    expect(JSON.parse(successJson({ a: 1 }))).toEqual({ ok: true, data: { a: 1 } });
    expect(JSON.parse(successJson({}, false)).ok).toBe(false);
    expect(JSON.parse(failureJson(new ConfigError("bad")))).toEqual({
      ok: false,
      error: { kind: "config", message: "bad" },
    });
  });

  test("an invalid config is {ok:false,error.kind:config} on stderr, stdout empty, exit 1", async () => {
    const r = await factory("run", "--repo-dir", repoDir({ repo: "a/b", typo: 1 }), "--issue", "1", "--json");
    expect(r.code).toBe(EXIT.error);
    expect(r.out).toBe("");
    const body = JSON.parse(r.err);
    expect(body.error.kind).toBe("config");
    expect(body.error.message).toContain("typo: unknown key");
  });

  test("a missing --issue is a usage error", async () => {
    const r = await factory("run", "--repo-dir", repoDir({ repo: "a/b" }), "--json");
    expect(r.code).toBe(EXIT.error);
    expect(JSON.parse(r.err).error.kind).toBe("usage");
  });

  test("doctor with an unusable config exits 4 and reports the failed check as JSON", async () => {
    const r = await factory("doctor", "--repo-dir", repoDir(), "--json");
    expect(r.code).toBe(EXIT.checksFailed);
    const body = JSON.parse(r.out);
    expect(body.ok).toBe(false);
    expect(body.data.checks[0].ok).toBe(false);
  });
});

test("the README exit-code table lists every code the CLI can return", () => {
  const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
  for (const code of Object.values(EXIT)) expect(readme).toMatch(new RegExp(`^\\| ${code} \\|`, "m"));
});

test("the CLI exits only through EXIT, never a bare number", () => {
  const src = readFileSync(cli, "utf8");
  expect([...src.matchAll(/process\.exit\((\d+)\)/g)].map((m) => m[0])).toEqual([]);
});

test("every pause-aware --json command exits EXIT.paused, so tick and watch --once agree", () => {
  const src = readFileSync(cli, "utf8");
  expect(src.match(/if \(result\.paused\) process\.exit\(EXIT\.paused\)/g)?.length).toBe(2);
});

describe("failureJson", () => {
  test("strips terminal escapes from an error message", () => {
    expect(JSON.parse(failureJson(new Error("bad\u001b[31m thing"))).error.message).toBe("bad thing");
  });
});
