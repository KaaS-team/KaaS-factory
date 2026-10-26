// v6.0.0's image pinned a gh that predates `closingIssuesReferences`, and the hosted inbox answered
// 500 on every read. These pin the scan that finds each field set and the check that runs them.

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoGhJsonCalls, unknownFields } from "../src/deploy/gh-fields";

const ROOT = join(import.meta.dir, "..");

test("the scan finds every gh --json call, the inbox's open PR list among them", () => {
  const calls = repoGhJsonCalls(ROOT);
  const inGithub = readFileSync(join(ROOT, "src/github.ts"), "utf8").match(/"--json",/g)!.length;
  expect(calls.filter((c) => c.file === "src/github.ts")).toHaveLength(inGithub);
  expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toContain("pr list");
  expect(calls.some((c) => c.args.at(-1)!.includes("closingIssuesReferences"))).toBe(true);
});

test("a field the gh on the path does not know is reported with gh's own words", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-fields-"));
  const gh = join(dir, "gh");
  writeFileSync(
    gh,
    '#!/bin/sh\ncase "$*" in *closingIssuesReferences*) echo \'Unknown JSON field: "closingIssuesReferences"\' >&2; exit 1;; esac\necho "HTTP 401: Bad credentials" >&2; exit 1\n',
  );
  chmodSync(gh, 0o755);
  const bad = unknownFields(repoGhJsonCalls(ROOT), gh);
  expect(bad.length).toBeGreaterThan(0);
  expect(bad.every((b) => b.error === 'Unknown JSON field: "closingIssuesReferences"')).toBe(true);
});

test("the image smoke runs the field check against the gh the image carries", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("docker exec factory bun src/deploy/gh-fields.ts");
});
