import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decidePr, parseApproved } from "../src/contributor-policy";
import { sanitizeEnv } from "../src/agents/env";
import { CAPABILITIES } from "../src/sandbox";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("pull request author gate", () => {
  const approved = parseApproved('{"logins": ["Friend"]}');
  test("maintainers and approved logins are kept, case-insensitively", () => {
    expect(decidePr({ login: "x", association: "MEMBER" }, approved)).toBe("keep");
    expect(decidePr({ login: "FRIEND", association: "NONE" }, approved)).toBe("keep");
  });
  test("an unlisted author is closed", () => {
    expect(decidePr({ login: "stranger", association: "FIRST_TIME_CONTRIBUTOR" }, approved)).toBe("close");
  });
  test("a malformed list throws", () => {
    expect(() => parseApproved('{"logins": [1]}')).toThrow("approved-contributors");
  });
  test("the script prints the pointer for a stranger", () => {
    const run = (...a: string[]) =>
      Bun.spawnSync(["bun", "scripts/pr-author-gate.ts", ...a], { timeout: 60_000, cwd: root }).stdout.toString();
    expect(run("stranger", "NONE")).toContain("close\n");
    expect(run("stranger", "NONE")).toContain("CONTRIBUTING.md");
    expect(run("Param-Harrison", "NONE")).toBe("keep\n");
  });
});

describe("SECURITY.md matches the code", () => {
  const text = read("SECURITY.md");
  test("says it is not a sandbox", () => {
    expect(text).toContain("The factory is not a sandbox");
  });
  test("per-runtime isolation and egress match CAPABILITIES", () => {
    const line = (k: string) => text.split("\n").find((l) => l.startsWith(`- \`${k}\``)) ?? "";
    expect(CAPABILITIES.local).toMatchObject({ isolation: "none", egress: "open" });
    expect(line("local")).toContain("no isolation and open egress");
    expect(CAPABILITIES.docker).toMatchObject({ isolation: "container", egress: "deny" });
    expect(line("docker")).toContain("container with egress denied");
    expect(CAPABILITIES.microsandbox).toMatchObject({ isolation: "microvm", egress: "deny" });
    expect(line("microsandbox")).toContain("microVM with egress denied");
    for (const k of ["ssh", "lwpr", "http", "agent37", "codespaces"] as const) {
      expect(CAPABILITIES[k].isolation).toBe("remote");
      expect(text).toContain(`\`${k}\``);
    }
    expect(CAPABILITIES.wrap.isolation).toBe("unknown");
    expect(CAPABILITIES.pool.isolation).toBe("unknown");
  });
  test("the stripped variables are exactly the ones named; provider keys pass", () => {
    const out = sanitizeEnv({
      GH_TOKEN: "a",
      GITHUB_TOKEN: "b",
      FACTORY_X: "c",
      GIT_DIR: "d",
      ANTHROPIC_API_KEY: "k",
      HOME: "/h",
    });
    expect(Object.keys(out).sort()).toEqual(["ANTHROPIC_API_KEY", "HOME"]);
    expect(text).toContain("`GH_TOKEN`, `GITHUB_TOKEN`, `FACTORY_*`");
    expect(text).toContain("model provider keys");
  });
});

describe("CONTRIBUTING.md and SECURITY.md name only things that exist", () => {
  const targets = readFileSync(join(root, "Makefile"), "utf8");
  const bins = new Set(["bun", "git", "make"]);
  for (const doc of ["CONTRIBUTING.md", "SECURITY.md"]) {
    const text = read(doc);
    test(`${doc}: paths exist`, () => {
      const paths = [...text.matchAll(/`([\w.\-/]+\/[\w.\-/]*|[\w.-]+\.(?:md|ts|json|yml))`/g)].map(
        (m) => m[1] as string,
      );
      const missing = paths.filter((p) => !p.startsWith("~") && !existsSync(join(root, p)));
      expect(missing).toEqual([]);
    });
    test(`${doc}: commands and make targets exist`, () => {
      const cmds = [...text.matchAll(/`((?:bun|make|git) [^`]+)`/g)].map((m) => m[1] as string);
      const bad: string[] = [];
      for (const c of cmds) {
        const [bin = "", arg = ""] = c.split(/\s+/);
        if (!bins.has(bin)) bad.push(c);
        else if (bin === "make" && !new RegExp(`^${arg}:`, "m").test(targets)) bad.push(c);
        else if (bin === "bun" && arg.endsWith(".ts") && !existsSync(join(root, arg))) bad.push(c);
      }
      expect(bad).toEqual([]);
    });
  }
  test("the files the docs name are matched by the checks above", () => {
    expect(read("CONTRIBUTING.md")).toContain("scripts/pr-author-gate.ts");
    expect(read("CONTRIBUTING.md")).toContain(".github/approved-contributors.json");
  });
});
