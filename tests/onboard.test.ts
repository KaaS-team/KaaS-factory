// `factory onboard` detects the stack, writes a starter config and lists what is missing.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForOnboard, scanLines } from "../src/onboard";

mkdirSync(tmpdir(), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "factory-onboard-scan-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function bunRepo(): string {
  const dir = mkdtempSync(join(scratch, "r-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "bun test" } }));
  writeFileSync(join(dir, "bun.lock"), "");
  return dir;
}

describe("onboard scan", () => {
  test("a bare repo gets a starter config, and the scan names what is still missing", () => {
    const dir = bunRepo();
    const scan = scanForOnboard(dir, true);
    expect(scan.wrote).toEqual([".factory/config.json"]);
    const config = JSON.parse(readFileSync(join(dir, ".factory", "config.json"), "utf8"));
    expect(config.gates.length).toBeGreaterThan(0);
    expect(scan.detected.join("\n")).toContain("stack:");
    expect(scan.missing.some((m) => m.includes("github origin remote"))).toBe(true);
    expect(scan.missing.some((m) => m.includes("charter"))).toBe(true);
    expect(scanLines(scan).some((l) => l.startsWith("  wrote "))).toBe(true);
  });

  test("a filled-in config is left alone", () => {
    const dir = bunRepo();
    mkdirSync(join(dir, ".factory"));
    const mine = JSON.stringify({ repo: "acme/w", gates: [{ name: "test", cmd: "true" }] });
    writeFileSync(join(dir, ".factory", "config.json"), mine);
    const scan = scanForOnboard(dir, true);
    expect(scan.wrote).toEqual([]);
    expect(readFileSync(join(dir, ".factory", "config.json"), "utf8")).toBe(mine);
  });

  test("dry run writes nothing and says so", () => {
    const dir = bunRepo();
    const scan = scanForOnboard(dir, false);
    expect(scan.wrote).toEqual([]);
    expect(existsSync(join(dir, ".factory", "config.json"))).toBe(false);
    expect(scan.missing[0]).toContain(".factory/config.json");
  });
});
