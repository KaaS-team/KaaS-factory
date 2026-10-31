import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "plan-batch.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[]) {
  const p = Bun.spawnSync(["bun", script, ...args]);
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("prints the picked names and the skipped reasons", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-batch-"));
  dirs.push(root);
  const specs = join(root, "specs");
  mkdirSync(specs);
  const body = (files: string[], deps = "none") =>
    `Deps: ${deps}\n\n## Files\n${files.map((f) => `- \`${f}\``).join("\n")}\n`;
  writeFileSync(join(specs, "a.md"), body(["src/a.ts"]));
  writeFileSync(join(specs, "b.md"), body(["src/a.ts"]));
  writeFileSync(join(specs, "c.md"), body(["src/c.ts"]));
  writeFileSync(join(specs, "d.md"), body(["src/d.ts"], "z"));
  writeFileSync(join(specs, "e.md"), body(["src/open.ts"]));
  const prs = join(root, "prs.json");
  writeFileSync(prs, JSON.stringify([{ number: 1, files: [{ path: "src/open.ts" }] }]));
  const r = run(["--specs", specs, "--prs", prs, "--limit", "9"]);
  expect(r.code).toBe(0);
  expect(r.out.trim().split("\n")).toEqual(["a", "c"]);
  expect(r.err).toContain("skipped: b overlap");
  expect(r.err).toContain("skipped: d deps");
  expect(r.err).toContain("skipped: e busy");
});

test("a missing specs directory exits 1 with a message", () => {
  const root = mkdtempSync(join(tmpdir(), "plan-batch-"));
  dirs.push(root);
  const prs = join(root, "prs.json");
  writeFileSync(prs, "[]");
  const r = run(["--specs", join(root, "nope"), "--prs", prs, "--limit", "2"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--specs directory not found");
});
