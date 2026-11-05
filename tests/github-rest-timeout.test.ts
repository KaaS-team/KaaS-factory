// PR create and merge go over REST with a request timeout (#580). A stalled `gh` (a fake one that never
// answers) must fail the step with the call named, after exactly one retry.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandResult, GhCommandRunner, GitHub } from "../src/github";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const opts = { repo: "o/r", base: "main", head: "feat/x", title: "t", body: "b", draft: true };

function scripted(results: Partial<CommandResult>[]) {
  const seen: { args: string[]; timeoutMs?: number }[] = [];
  const runner = {
    run: async (args: string[], o?: { timeoutMs?: number }) => {
      seen.push({ args, timeoutMs: o?.timeoutMs });
      return { stdout: "", stderr: "", code: 0, ...results[Math.min(seen.length - 1, results.length - 1)] };
    },
  };
  return { seen, gh: new GitHub(runner, 50) };
}

describe("createPr over REST", () => {
  test("POSTs /pulls with a timeout and returns the html_url", async () => {
    const { seen, gh } = scripted([{ stdout: JSON.stringify({ html_url: "https://github.com/o/r/pull/9" }) }]);
    expect(await gh.createPr(opts)).toBe("https://github.com/o/r/pull/9");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/o/r/pulls"]);
    expect(seen[0]!.timeoutMs).toBe(50);
  });

  test("a timeout is retried once, then the step fails naming the call", async () => {
    const { seen, gh } = scripted([{ code: 124, timedOut: true }]);
    await expect(gh.createPr(opts)).rejects.toThrow("POST repos/o/r/pulls timed out");
    expect(seen).toHaveLength(2);
  });

  test("a call that times out once and then answers succeeds", async () => {
    const { seen, gh } = scripted([{ code: 124, timedOut: true }, { stdout: JSON.stringify({ html_url: "u" }) }]);
    expect(await gh.createPr(opts)).toBe("u");
    expect(seen).toHaveLength(2);
  });

  test("a refusal is thrown at once and never retried", async () => {
    const { seen, gh } = scripted([{ code: 1, stderr: "HTTP 422 Validation Failed" }]);
    await expect(gh.createPr(opts)).rejects.toThrow("422");
    expect(seen).toHaveLength(1);
  });
});

describe("mergePr over REST", () => {
  test("a timeout is retried once, then fails naming the call", async () => {
    const { seen, gh } = scripted([{ code: 124, timedOut: true }]);
    await expect(gh.mergePr("o/r", 7, "abc")).rejects.toThrow("PUT repos/o/r/pulls/7/merge timed out");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.timeoutMs).toBe(50);
  });
});

describe("a stalled gh", () => {
  test("GhCommandRunner kills a call that outlives timeoutMs and reports it", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "stall-"));
    roots.push(dir);
    const count = join(dir, "count");
    writeFileSync(count, "");
    // Stands in for a server that accepts the request and never answers.
    writeFileSync(join(dir, "gh"), `#!/bin/sh\necho x >> "${count}"\nexec sleep 30\n`);
    chmodSync(join(dir, "gh"), 0o755);
    const runner = new GhCommandRunner();
    const env = { PATH: `${dir}:${process.env.PATH}` };
    const started = Date.now();
    const gh = new GitHub({ run: (args, o) => runner.run(args, { ...o, env }) }, 300);
    await expect(gh.createPr(opts)).rejects.toThrow("POST repos/o/r/pulls timed out");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
