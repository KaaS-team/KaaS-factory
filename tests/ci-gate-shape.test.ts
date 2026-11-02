import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const wfPath = existsSync(join(ROOT, "ci", "ci.yml"))
  ? join(ROOT, "ci", "ci.yml")
  : join(ROOT, ".github", "workflows", "ci.yml");
const text = readFileSync(wfPath, "utf8");
const lines = text.split("\n");

function stepBlock(name: string): string {
  const i = lines.findIndex((l) => l.includes(`name: ${name}`));
  if (i < 0) throw new Error(`no step named ${name}`);
  let end = i + 1;
  while (end < lines.length) {
    const line = lines[end]!;
    if (line.startsWith("      - name:") || line.startsWith("      - uses:")) break;
    end++;
  }
  return lines.slice(i, end).join("\n");
}

test("make check keeps the empty HOME gate and tees a log", () => {
  const block = stepBlock("make check");
  expect(block.includes('HOME="$(mktemp -d)" make check')).toBe(true);
  expect(block.includes("tee reports/check-output.log")).toBe(true);
  expect(block.includes("MAKEFLAGS: -k")).toBe(true);
});

test("a failure step summarizes tests with the check log", () => {
  expect(
    lines.some(
      (l, i) =>
        l.trim() === "if: failure()" &&
        lines
          .slice(i, i + 3)
          .join("\n")
          .includes("scripts/test-failures.ts") &&
        lines
          .slice(i, i + 3)
          .join("\n")
          .includes("--log"),
    ),
  ).toBe(true);
});

test("docker-build steps after inputs are gated on build output", () => {
  const jobStart = lines.findIndex((l) => l.trim() === "docker-build:");
  expect(jobStart).toBeGreaterThan(-1);
  const next = lines.findIndex((l, i) => i > jobStart && /^ {2}[a-z][a-z-]*:$/.test(l));
  const jobLines = lines.slice(jobStart, next < 0 ? lines.length : next);
  const starts = jobLines.flatMap((l, i) => (l.startsWith("      - ") ? [i] : []));
  const steps = starts.map((s, k) => jobLines.slice(s, starts[k + 1] ?? jobLines.length).join("\n"));
  const inputsStep = steps.findIndex((b) => b.includes("id: inputs"));
  expect(inputsStep).toBeGreaterThan(-1);
  const gated = steps.slice(inputsStep + 1);
  expect(gated.length).toBeGreaterThan(0);
  for (const block of gated) {
    expect(block.includes("steps.inputs.outputs.build == 'true'")).toBe(true);
  }
});
