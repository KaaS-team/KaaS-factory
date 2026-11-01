// The optional Try it section: try-it.json becomes a PR body section, and no file means no section.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problems } from "../scripts/check-pr-body";
import { prBody, prExtras } from "../src/engine/pr-body";
import { readTryIt, tryItSection } from "../src/try-it";

const scratch = (prefix: string) => {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
};

const write = (dir: string, value: unknown) => {
  mkdirSync(join(dir, ".factory/runs/issue-5"), { recursive: true });
  writeFileSync(join(dir, ".factory/runs/issue-5/try-it.json"), JSON.stringify(value));
};

describe("try it section", () => {
  test("a try-it.json renders the command and its expected output in the PR body", async () => {
    const dir = scratch("factory-tryit-");
    try {
      write(dir, { command: "bun run factory --help", output: "Usage: factory" });
      const extras = await prExtras(dir, { repo: "o/r" }, 5, []);
      const body = prBody("Closes #5", extras);
      expect(body).toContain("## Try it\n\n```\nbun run factory --help\n```");
      expect(body).toContain("Expected output:\n\n```\nUsage: factory\n```");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("no file, an empty command or a multi-line command: no section", () => {
    const dir = scratch("factory-tryit-");
    try {
      expect(readTryIt(dir, 5)).toBe(undefined);
      expect(prBody("Closes #5", { tryIt: readTryIt(dir, 5) })).not.toContain("## Try it");
      write(dir, { command: "  ", output: "x" });
      expect(readTryIt(dir, 5)).toBe(undefined);
      write(dir, { command: "a\nb", output: "x" });
      expect(readTryIt(dir, 5)).toBe(undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("output holding a code fence cannot close the section's fence early", () => {
    const text = tryItSection({ command: "cat x", output: "```\nrm -rf\n```" });
    expect(text).toContain("````\n```\nrm -rf\n```\n````");
  });
  test("the section is optional: the template check passes with and without it", () => {
    const template = "## Summary\n\n## Plan\n";
    const base = "## Summary\nDid it.\n\n## Plan\nSee plan.";
    const section = tryItSection({ command: "make check", output: "ok" });
    expect(problems(base, template)).toEqual([]);
    expect(problems(`${base}\n\n${section}`, template)).toEqual([]);
  });
});
