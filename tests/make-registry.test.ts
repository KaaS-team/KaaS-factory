import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const checkLine = (dir: string): string[] => {
  const out = Bun.spawnSync(["make", "-pn", "check"], { cwd: dir }).stdout.toString();
  const line = out.split("\n").find((l) => l.startsWith("check:"));
  return line?.slice("check:".length).trim().split(/\s+/) ?? [];
};

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "make-registry-"));
  cpSync("Makefile", join(dir, "Makefile"));
  return dir;
};

describe("make registry", () => {
  test("a make/*.mk file adds its CHECK_EXTRA to the check prerequisites", () => {
    const dir = fixture();
    mkdirSync(join(dir, "make"));
    writeFileSync(
      join(dir, "make/probe.mk"),
      ".PHONY: check-probe\nCHECK_EXTRA += check-probe\ncheck-probe:\n\t@true\n",
    );
    const words = checkLine(dir);
    expect(words).toContain("check-probe");
    expect(words).toContain("check-anchors");
    expect(words).toContain("check-baseline");
  });

  test("with no make/ directory check still works", () => {
    const words = checkLine(fixture());
    expect(words).toContain("check-baseline");
  });

  test("every check-* target in make/*.mk is in its own .PHONY and CHECK_EXTRA", () => {
    const dirName = "make";
    const files = existsSync(dirName) ? readdirSync(dirName).filter((f) => f.endsWith(".mk")) : [];
    for (const file of files) {
      const text = readFileSync(join(dirName, file), "utf8");
      const lines = text.split("\n");
      const targets = lines.map((l) => /^(check-[\w.-]+)\s*:(?!=)/.exec(l)?.[1]).filter((t): t is string => Boolean(t));
      const phony = lines
        .filter((l) => l.startsWith(".PHONY:"))
        .join(" ")
        .split(/\s+/);
      const extra = lines
        .filter((l) => /^CHECK_EXTRA\s*\+=/.test(l))
        .join(" ")
        .split(/\s+/);
      for (const t of targets) {
        expect(phony).toContain(t);
        expect(extra).toContain(t);
      }
    }
  });
});
