// The P6 merge and package keys, kept out of config.ts so its validator stays one table of shapes.
import type { Autonomy } from "./autonomy";

export interface MergeAutonomyFields {
  // Who merges (src/autonomy.ts); absent reads from policy, where "auto" is "semi".
  readonly autonomy?: Autonomy;
  // The live URL the post-merge watch smokes, and the PR preview URL with `{pr}` (src/visual.ts).
  readonly smokeUrl?: string;
  readonly previewUrl?: string;
  // The low-risk class a merge with no human must stay inside; absent is docs, tests and copy
  // (src/low-risk.ts). It can never take in a migration, auth, dependency, CI or infra path.
  readonly lowRiskPaths?: readonly string[];
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
  lowRiskPaths: "strings",
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
  ];
}
