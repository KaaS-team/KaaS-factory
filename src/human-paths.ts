// Paths a human always reviews, in every profile. A diff touching one is never auto-merged.
// The defaults are fixed here and unioned with a repo's `review.alwaysHumanPaths`, so a team can
// add paths but cannot remove a default: the policy only tightens (issue #367).
import type { MergeRefusal } from "./merge-policy";

export const DEFAULT_HUMAN_PATHS = [
  ".github/workflows/**",
  "CODEOWNERS",
  ".github/CODEOWNERS",
  "docs/CODEOWNERS",
  ".factory/**", // includes .factory/config.json
] as const;

// The one resolver: the defaults, then the repo's additions, without duplicates.
export const humanPaths = (extra: readonly string[] = []): string[] => [
  ...new Set<string>([...DEFAULT_HUMAN_PATHS, ...extra]),
];

export function humanPathRefusals(
  files: readonly { readonly path: string }[],
  extra: readonly string[] = [],
): MergeRefusal[] {
  const globs = humanPaths(extra).map((pattern) => new Bun.Glob(pattern));
  const hits = files.map((f) => f.path).filter((path) => globs.some((g) => g.match(path)));
  return hits.length > 0
    ? [{ reason: "not-auto-eligible", detail: `needs human review (review.alwaysHumanPaths): ${hits.join(", ")}` }]
    : [];
}
