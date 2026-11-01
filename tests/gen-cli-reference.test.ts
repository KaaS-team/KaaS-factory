import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../scripts/gen-cli-reference";
import { COMMANDS } from "../src/help";

const script = join(import.meta.dir, "..", "scripts", "gen-cli-reference.ts");
const check = async (path: string) =>
  await Bun.spawn(["bun", script, "--check", "--path", path], { stdout: "pipe", stderr: "pipe" }).exited;

describe("gen-cli-reference", () => {
  test("render mentions every command the help lists", () => {
    const out = render();
    for (const c of COMMANDS) expect(out).toContain(`### ${c.name}`);
  });

  test("the committed reference is fresh", async () => {
    expect(await check(join(import.meta.dir, "..", "docs", "cli-reference.md"))).toBe(0);
  });

  test("--check exits 1 on an edited copy and 0 on a fresh one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-ref-"));
    const file = join(dir, "ref.md");
    writeFileSync(file, render());
    expect(await check(file)).toBe(0);
    writeFileSync(file, `${readFileSync(file, "utf8")}drift\n`);
    expect(await check(file)).toBe(1);
  });
});
