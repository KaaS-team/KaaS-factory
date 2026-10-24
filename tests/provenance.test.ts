// Ported code must say where it came from, and this file must say the same thing.
// A header with no notice, a notice with no header, or a port with no ported
// upstream test is a failure, so a copy cannot land unrecorded (Rule 0).

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const HEADER =
  /Ported from (?:owainlewis|mastra-ai)\/([a-z.-]+)@([0-9a-f]{7}) (\S+) \((?:MIT, Copyright \(c\) 2026 Owain Lewis|Apache-2\.0, (?:[^()]|\([^)]*\))+)\)\. Deviations: \S/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if ([".git", ".worktrees", "node_modules", "template", "workspaces"].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|js|css)$/.test(name)) out.push(path);
  }
  return out;
}

// Skills are ported too; their header is an HTML comment in the first lines.
function walkTemplate(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkTemplate(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

const sources = [...walk(root), ...walkTemplate(join(root, "template"))];
const headers = sources.flatMap((file) => {
  const first = readFileSync(file, "utf8")
    .split("\n")
    .slice(0, file.endsWith(".md") ? 8 : 2)
    .join("\n");
  const m = HEADER.exec(first);
  return first.includes("Ported from ") ? [{ file: relative(root, file), m }] : [];
});

const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const entries = [...notices.matchAll(/^## (?:owainlewis|mastra-ai)\/([a-z.-]+)@([0-9a-f]{7})$/gm)].map(
  (m) => `${m[1]}@${m[2]}`,
);
const rows = [...notices.matchAll(/^- `([^`]+)` from .*$/gm)].map((m) => ({ file: m[1]!, line: m[0] }));
const listed = rows.map((r) => r.file);

test("every Ported-from header is well formed", () => {
  expect(headers.length).toBeGreaterThan(0);
  for (const h of headers) expect(h.m, `${h.file}: header does not match the required format`).not.toBeNull();
});

test("every ported file is listed in THIRD_PARTY_NOTICES.md under its repo and commit", () => {
  for (const h of headers) {
    expect(entries, `${h.file}: no notices section for ${h.m![1]}@${h.m![2]}`).toContain(`${h.m![1]}@${h.m![2]}`);
    // Ported tests are covered by their repo's section; ported source files are listed one by one.
    if (!h.file.startsWith("tests/ported/"))
      expect(listed, `${h.file}: not listed in THIRD_PARTY_NOTICES.md`).toContain(h.file);
  }
});

test("every file listed in the notices exists and carries a header", () => {
  const withHeader = new Set(headers.map((h) => h.file));
  for (const file of listed) {
    expect(existsSync(join(root, file)), `${file} is listed but missing`).toBe(true);
    expect(withHeader.has(file), `${file} is listed but has no Ported-from header`).toBe(true);
  }
});

test("every listed port names its upstream test, or says it has none", () => {
  for (const { file, line } of rows) {
    const t = /\[tested by `([^`]+)`\]/.exec(line);
    if (!t) {
      expect(line, `${file}: needs [tested by \`tests/ported/...\`] or [no upstream test]`).toContain(
        "[no upstream test]",
      );
      continue;
    }
    const path = join(root, t[1]!);
    expect(existsSync(path), `${file}: ${t[1]} does not exist`).toBe(true);
    expect(readFileSync(path, "utf8").split("\n").slice(0, 2).join("\n"), `${t[1]}: no Ported-from header`).toContain(
      "Ported from ",
    );
  }
});

test("every ported repo has ported upstream tests, and the licence text is included", () => {
  for (const repo of new Set(headers.map((h) => h.m![1]!))) {
    const dir = join(root, "tests", "ported", repo);
    expect(
      existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".test.ts")),
      `no tests/ported/${repo}/*.test.ts`,
    ).toBe(true);
  }
  expect(notices).toContain("MIT License");
  expect(notices).toContain("Copyright (c) 2026 Owain Lewis");
});
