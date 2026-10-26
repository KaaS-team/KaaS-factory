// What scaleup and enterprise add beyond PROFILES' defaults (src/profile-rules.ts): code-owner
// approval before a factory merge, a sandbox for gates and checks, and team and org caps.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems, mergeConfig } from "../src/config";
import { GitHub } from "../src/github";
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

  test("`dir/*` owns a directory's direct children only, and any other match owns everything under it", () => {
    const rules = parseCodeowners("*  @lead\n/docs/sub/  @sub\ndocs/*  @writer\n/src/*.ts @ts\n");
    expect(ownersOf(rules, "docs/a.md")).toEqual(["@writer"]);
    expect(ownersOf(rules, "docs/sub/b.md")).toEqual(["@sub"]);
    expect(ownersOf(rules, "src/a.ts")).toEqual(["@ts"]);
    expect(ownersOf(rules, "src/lib/a.ts")).toEqual(["@lead"]);
    // Any other wildcard that matches a directory owns the files inside it.
    const nested = parseCodeowners("config*  @ops\n*.d  @ops\n");
    expect(ownersOf(nested, "configs/prod.yml")).toEqual(["@ops"]);
    expect(ownersOf(nested, "conf.d/a.conf")).toEqual(["@ops"]);
    expect(ownersOf(parseCodeowners("docs/*  @writer\n"), "docs/a/b.md")).toEqual([]);
    expect(ownersOf(parseCodeowners("docs/*  @writer\n"), "docs/a.md")).toEqual(["@writer"]);
  });

  test("a code owner's approval of an older commit does not satisfy the owner wait", async () => {
    const view = {
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefOid: "new",
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      // What gh really returns: latestReviews with commit.oid never filled in.
      latestReviews: [
        { author: { login: "dba" }, state: "APPROVED", commit: { oid: "" } },
        { author: { login: "lead" }, state: "APPROVED", commit: { oid: "" } },
      ],
    };
    const latestReviews = {
      nodes: [
        { author: { login: "dba" }, state: "APPROVED", commit: { oid: "old" } },
        { author: { login: "lead" }, state: "APPROVED", commit: { oid: "new" } },
      ],
    };
    const pullRequest = { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, latestReviews };
    const graphql = { data: { repository: { pullRequest } } };
    const gh = new GitHub({
      run: async (args: string[]) => ({
        code: 0,
        stdout: JSON.stringify(args[0] === "api" ? graphql : view),
        stderr: "",
      }),
    });
    const r = await gh.mergeReadiness("o/r", 1);
    expect(r.approvedBy).toEqual(["lead"]);
    const held = decideMerge({
      readiness: r,
      ci: { ...ci, headSha: "new" },
      risk: "low",
      changedFiles: [{ path: "db/1.sql", additions: 1, deletions: 0 }],
      merge: { policy: "auto", autoPaths: ["**"], maxFiles: 10, maxLines: 200 },
      protectedPaths: [],
      expectedBaseRefName: "main",
      codeowners: { rules: parseCodeowners("*.sql @dba\n"), approvedBy: r.approvedBy ?? [] },
    });
    expect(held.outcome === "refuse" && held.refusals.map((x) => x.reason)).toEqual(["codeowner-approval"]);
  });
});
