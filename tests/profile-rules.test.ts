// What scaleup and enterprise add beyond PROFILES' defaults (src/profile-rules.ts): code-owner
// approval before a factory merge, a sandbox for gates and checks, and team and org caps.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, mergeConfig } from "../src/config";
import { decideMerge } from "../src/merge-policy";
import { capsFor, codeownerCheck, ownersOf, parseCodeowners } from "../src/profile-rules";

const readiness = {
  state: "open" as const,
  isDraft: false,
  baseRefName: "main",
  headRefOid: "sha1",
  mergeable: "MERGEABLE" as const,
  reviewDecision: "APPROVED" as const,
  hasUnresolvedReviewThreads: false,
  changesRequestedStale: false,
};
const ci = {
  prNumber: 1,
  headSha: "sha1",
  status: "passed" as const,
  checks: [{ name: "b", status: "COMPLETED", conclusion: "SUCCESS" }],
};

describe("scaleup and enterprise profile rules", () => {
  test("a merge waits for each touched file's code owner, enterprise forces a sandbox, and both cap teams", () => {
    const base = mkdtempSync(join(tmpdir(), "factory-codeowners-"));
    mkdirSync(join(base, ".github"));
    writeFileSync(join(base, ".github/CODEOWNERS"), "*  @lead\n/docs/  @writer\n*.sql @dba @lead # schema\nvendor/\n");
    const rules = parseCodeowners("*  @lead\n/docs/  @writer\n*.sql @dba @lead # schema\nvendor/\n");
    expect(ownersOf(rules, "docs/a/b.md")).toEqual(["@writer"]);
    expect(ownersOf(rules, "db/x/1.sql")).toEqual(["@dba", "@lead"]);
    expect(ownersOf(rules, "lib/vendor/x.js")).toEqual([]);
    expect(ownersOf(rules, "src/app.ts")).toEqual(["@lead"]);

    const changedFiles = [
      { path: "docs/guide.md", additions: 1, deletions: 0 },
      { path: "db/1.sql", additions: 1, deletions: 0 },
    ];
    const decide = (profile: "team" | "scaleup", approvedBy: string[]) =>
      decideMerge({
        readiness,
        ci,
        risk: "low",
        changedFiles,
        merge: { policy: "auto", autoPaths: ["**"], maxFiles: 10, maxLines: 200 },
        protectedPaths: [],
        expectedBaseRefName: "main",
        codeowners: codeownerCheck(profile, base, approvedBy),
      });
    expect(decide("team", []).outcome).toBe("merge");
    const held = decide("scaleup", ["writer"]);
    expect(held.outcome === "refuse" && held.refusals[0]?.detail).toBe("no code owner approved db/1.sql (@dba @lead)");
    expect(decide("scaleup", ["writer", "lead"]).outcome).toBe("merge");
    expect(codeownerCheck("enterprise", base, undefined)?.approvedBy).toEqual([]);
    rmSync(base, { recursive: true, force: true });

    const sandbox = (runtime?: object) =>
      configProblems({ repo: "a/b", profile: "enterprise", ...(runtime ? { runtime } : {}) });
    expect(sandbox()).toHaveLength(2);
    expect(sandbox({ gates: "local", check: "docker" })).toEqual([
      'runtime.gates: the enterprise profile runs gates and checks in a sandbox; name a runtime other than "local"',
    ]);
    expect(sandbox({ gates: "docker", check: "docker" })).toEqual([]);
    expect(configProblems({ repo: "a/b", profile: "scaleup" })).toEqual([]);

    expect(capsFor(mergeConfig({ repo: "a/b", profile: "scaleup" }))).toEqual({ perTeam: 3, org: 10 });
    expect(capsFor(mergeConfig({ repo: "a/b", profile: "enterprise" }))).toEqual({ perTeam: 2, org: 10 });
    expect(capsFor(mergeConfig({ repo: "a/b", profile: "team" }))).toBeUndefined();
    expect(capsFor(mergeConfig({ repo: "a/b", profile: "scaleup", caps: { perTeam: 5 } }))).toEqual({ perTeam: 5 });
  });
});
