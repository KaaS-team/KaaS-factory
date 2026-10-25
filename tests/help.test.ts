// `factory --help` must list exactly the commands the dispatcher handles,
// and asking for help must exit 0.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS, helpText } from "../src/help";

const bin = join(import.meta.dir, "..", "bin", "factory");
const cli = join(import.meta.dir, "..", "src", "cli.ts");

describe("factory help", () => {
  test("lists exactly the dispatcher's commands", () => {
    const handled = [...readFileSync(cli, "utf8").matchAll(/^ {4}case "([a-z-]+)":/gm)].map((m) => m[1]!).sort();
    expect(COMMANDS.map((c) => c.name).sort()).toEqual(handled);
    expect(handled.length).toBeGreaterThan(5);
  });

  test("every flag the CLI reads is documented", () => {
    const used = new Set([...readFileSync(cli, "utf8").matchAll(/(?:flag|has)\("([a-z-]+)"\)/g)].map((m) => m[1]));
    for (const f of used) expect(helpText()).toContain(`--${f}`);
  });

  for (const arg of ["-h", "--help", "help"]) {
    test(`${arg} exits 0 and prints usage`, async () => {
      const proc = Bun.spawn(["bun", bin, arg], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(out).toContain("factory <command>");
    });
  }

  test("an unknown command exits 1", async () => {
    const proc = Bun.spawn(["bun", bin, "bogus"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
  });
});

test("a missing config exits 1 with a one-line error, not a stack trace", async () => {
  const dir = (await import("node:fs")).mkdtempSync(join((await import("node:os")).tmpdir(), "factory-noconf-"));
  const proc = Bun.spawn(["bun", bin, "tick", "--repo-dir", dir], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(err).toContain("config.json");
  expect(err).not.toContain("    at ");
});
