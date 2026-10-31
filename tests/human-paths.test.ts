import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiResult } from "../src/ci";
import { loadConfig, mergeConfig, PROFILES, type Profile } from "../src/config";
import { DEFAULT_HUMAN_PATHS, humanPaths } from "../src/human-paths";
import type { MergeReadiness } from "../src/github";
import { tierInput } from "../src/merge-autonomy";
import { decideMerge } from "../src/merge-policy";

const ready: MergeReadiness = {
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefOid: "sha1",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  hasUnresolvedReviewThreads: false,
  changesRequestedStale: false,
};
const ci: CiResult = {
  prNumber: 1,
  headSha: "sha1",
  status: "passed",
  checks: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
};

const decide = (profile: Profile, path: string, humanPaths?: readonly string[]) => {
  const config = mergeConfig({ profile, merge: { policy: "auto", autoPaths: ["**"], maxFiles: 10, maxLines: 200 } });
  return decideMerge({
    readiness: ready,
    ci,
    risk: "low",
    changedFiles: [{ path, additions: 1, deletions: 0 }],
    merge: config.merge,
    protectedPaths: [],
    expectedBaseRefName: "main",
    humanPaths,
  });
};

for (const profile of Object.keys(PROFILES) as Profile[]) {
  test(`${profile}: a workflow diff is refused for auto-merge`, () => {
    const d = decide(profile, ".github/workflows/ci.yml");
    expect(d.outcome).toBe("refuse");
    if (d.outcome !== "refuse") return;
    expect(d.refusals.map((r) => r.detail)).toContain(
      "needs human review (review.alwaysHumanPaths): .github/workflows/ci.yml",
    );
  });
}

test("every default path is refused and an ordinary path still merges", () => {
  for (const glob of DEFAULT_HUMAN_PATHS) {
    const path = glob.replace("**", "x/y.txt");
    expect(decide("solo", path).outcome).toBe("refuse");
  }
  expect(decide("solo", "src/ok.ts").outcome).toBe("merge");
});

test("a team adds paths; the defaults stay whatever it sets", () => {
  expect(decide("solo", "infra/prod.tf", ["infra/**"]).outcome).toBe("refuse");
  expect(decide("solo", "infra/prod.tf").outcome).toBe("merge");
  expect(humanPaths([])).toEqual([...DEFAULT_HUMAN_PATHS]);
  expect(humanPaths(["infra/**", "CODEOWNERS"])).toEqual([...DEFAULT_HUMAN_PATHS, "infra/**"]);
  expect(decide("solo", ".github/workflows/ci.yml", ["infra/**"]).outcome).toBe("refuse");
});

test("review.alwaysHumanPaths loads from config and a typo key is refused", async () => {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "human-paths-"));
  try {
    mkdirSync(join(dir, ".factory"));
    writeFileSync(
      join(dir, ".factory/config.json"),
      JSON.stringify({ repo: "o/r", review: { alwaysHumanPaths: ["infra/**"] } }),
    );
    expect((await loadConfig(dir)).review).toEqual({ alwaysHumanPaths: ["infra/**"] });
    writeFileSync(join(dir, ".factory/config.json"), JSON.stringify({ repo: "o/r", review: { humanPaths: [] } }));
    await expect(loadConfig(dir)).rejects.toThrow("review.humanPaths");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the watcher's merge inputs carry review.alwaysHumanPaths", () => {
  const config = mergeConfig({ review: { alwaysHumanPaths: ["infra/**"] } });
  expect(tierInput(undefined, config, "low").humanPaths).toEqual(["infra/**"]);
});
