import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND_URL, DEFAULT_FOOTER, SHIPPED_WITH, brandFooter, brandLineProblems, versionLine } from "../src/brand";
import { configProblems } from "../src/config";
import { prBody } from "../src/engine/pr-body";
import { GitCommandRunner } from "../src/git";
import { RUNNER_VERSION, VERSION_TEXT } from "../src/version";

describe("brand footer", () => {
  test("every PR body ends with the footer linking to kaas.team", () => {
    const body = prBody("Closes #1");
    expect(body.endsWith(DEFAULT_FOOTER)).toBe(true);
    expect(body).toContain(BRAND_URL);
    expect(body.split(DEFAULT_FOOTER).length).toBe(2);
  });

  test("the footer is configurable and still ends the body", () => {
    const own = `Built with [our factory](${BRAND_URL})`;
    expect(prBody("x", { footer: own, acceptance: "## Acceptance\n- a" }).endsWith(own)).toBe(true);
    expect(configProblems({ brand: { footer: own } })).toEqual([]);
  });

  test("a footer without the kaas.team link is refused", () => {
    expect(() => brandFooter("Shipped by us")).toThrow("must link to");
    expect(configProblems({ brand: { footer: "no link" } }).join()).toContain("must link to");
    expect(configProblems({ brand: { colour: "red" } }).join()).toContain("unknown key");
  });
});

describe("commit trailer", () => {
  test("a factory commit carries Shipped-with, for commit and commit-tree", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "brand-"));
    try {
      const run = (a: string[]) => new GitCommandRunner().run(a, { cwd: dir });
      await run(["init", "-q"]);
      await run(["config", "user.name", "T"]);
      await run(["config", "user.email", "t@example.com"]);
      writeFileSync(join(dir, "f"), "x");
      await run(["add", "f"]);
      await run(["commit", "-s", "-m", "one"]);
      const log = (await run(["log", "-1", "--format=%(trailers:key=Shipped-with,valueonly)"])).stdout.trim();
      expect(log).toBe(`KaaS Factory (${BRAND_URL})`);
      const tree = (await run(["write-tree"])).stdout.trim();
      const sha = (await run(["commit-tree", tree, "-m", "two"])).stdout.trim();
      expect((await run(["log", "-1", "--format=%B", sha])).stdout).toContain(SHIPPED_WITH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("--version", () => {
  test("prints the version and the kaas.team link", () => {
    expect(VERSION_TEXT).toBe(`${RUNNER_VERSION} (${BRAND_URL})`);
    expect(versionLine("1.2.3")).toBe("1.2.3 (https://kaas.team)");
    const out = Bun.spawnSync(["bun", "src/cli.ts", "--version"], { timeout: 30000 }).stdout.toString();
    expect(out.trim()).toBe(VERSION_TEXT);
  });
});

describe("no model name or cost in the brand lines", () => {
  const lines = { footer: DEFAULT_FOOTER, trailer: SHIPPED_WITH, version: VERSION_TEXT };
  for (const [what, line] of Object.entries(lines))
    test(`the ${what} is clean`, () => expect(brandLineProblems(line, what)).toEqual([]));

  test("a model name or a dollar figure is caught", () => {
    expect(brandLineProblems("Shipped with Claude Sonnet", "x")).toHaveLength(1);
    expect(brandLineProblems("cost $0.42", "x")).toHaveLength(1);
    expect(brandLineProblems("12,000 tokens", "x")).toHaveLength(1);
    expect(() => brandFooter(`Made by gpt ${BRAND_URL}`)).toThrow("names a model");
  });
});

describe("public docs", () => {
  test("SECURITY.md is a policy: it says how to report", () => {
    expect(readFileSync("SECURITY.md", "utf8")).toMatch(/## Reporting/);
  });
});

describe("README template", () => {
  const text = readFileSync("docs/readme-template.md", "utf8");
  test("has a Built by KaaS block that links to kaas.team", () => {
    const block = text.split(/^## /m).find((s) => s.startsWith("Built by KaaS")) ?? "";
    expect(block).toContain(BRAND_URL);
  });
  test("has a repo table whose rows each carry a description", () => {
    const rows = text.split("\n").filter((l) => /^\| \[/.test(l));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.split("|")[2]?.trim().length).toBeGreaterThan(0);
    expect(brandLineProblems(text, "readme")).toEqual([]);
  });
});
