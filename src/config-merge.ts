// The P6 merge and package keys, kept out of config.ts so its validator stays one table of shapes.
import type { Autonomy } from "./autonomy";

export interface MergeAutonomyFields {
  // Who merges (src/autonomy.ts); absent reads from policy, where "auto" is "semi".
  readonly autonomy?: Autonomy;
  // The live URL the post-merge watch smokes, and the PR preview URL with `{pr}` (src/visual.ts).
  readonly smokeUrl?: string;
  readonly previewUrl?: string;
  // How `gh pr merge` merges, and who queues it (src/merge-method.ts); absent is squash, factory-run.
  readonly method?: "squash" | "rebase" | "merge" | "host";
  readonly queue?: "factory" | "host" | "none";
}

export interface PackageOwnership {
  // People who own the package: a change under it never merges without one of them (src/risk.ts).
  readonly owners?: readonly string[];
  // Globs relative to the package path, protected like the top-level protectedPaths.
  readonly protectedPaths?: readonly string[];
}

export const MERGE_KEYS = {
  policy: "string",
  autoPaths: "strings",
  maxFiles: "posInt",
  maxLines: "posInt",
  autonomy: "string",
  smokeUrl: "string",
  previewUrl: "string",
  method: "string",
  queue: "string",
} as const;

export const PACKAGE_KEYS = {
  path: "string",
  gates: "object",
  always: "boolean",
  owners: "strings",
  protectedPaths: "strings",
} as const;

const oneOf = (key: string, v: unknown, allowed: readonly string[]) =>
  v === undefined || allowed.includes(v as string)
    ? []
    : [
        `merge.${key}: expected ${allowed
          .map((a) => `"${a}"`)
          .join(", ")
          .replace(/, ([^,]*)$/, " or $1")}, got ${JSON.stringify(v)}`,
      ];

export function mergeProblems(merge: Record<string, unknown>): string[] {
  return [
    ...oneOf("policy", merge.policy, ["off", "dry-run", "auto"]),
    ...oneOf("autonomy", merge.autonomy, ["supervised", "semi", "full"]),
    ...oneOf("method", merge.method, ["squash", "rebase", "merge", "host"]),
    ...oneOf("queue", merge.queue, ["factory", "host", "none"]),
  ];
}

// `review.alwaysHumanPaths`: globs a human always reviews, added to the defaults in src/human-paths.ts.
export interface ReviewFields {
  readonly review?: { readonly alwaysHumanPaths?: readonly string[]; readonly maxRounds?: number };
}
