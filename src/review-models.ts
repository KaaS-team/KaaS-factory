// The reviewer never shares the builder's model: one model grading its own work misses the same
// things twice. High risk adds a second reviewer, on yet another model when the pool has one.

import type { Risk } from "./artifacts";
import { reviewerCount } from "./autonomy";

export function reviewerModels(builder: string, risk: Risk, pool: readonly string[]): string[] {
  const others = [...new Set(pool)].filter((m) => m !== builder);
  return others.slice(0, reviewerCount(risk));
}

// The model the verify stage runs on: its own, unless that is the builder's, then the first other
// model in its pool. With no other model it keeps its own; the PR facts then refuse a full auto-merge.
export function reviewModel(
  verify: string | undefined,
  builder: string | undefined,
  pool: readonly (string | undefined)[],
): string | undefined {
  if (!builder || verify !== builder) return verify;
  return (
    reviewerModels(
      builder,
      "low",
      pool.filter((m): m is string => !!m),
    )[0] ?? verify
  );
}

interface ModelAgent {
  readonly config: { readonly model?: string; readonly models?: Readonly<Record<string, string>> };
}

// Verify never grades the build on the builder's own model; `builder` is the build route's agent.
// Reviewer `n` past the first takes the pool's n-th model other than the builder's, if it has one.
export function crossModel<A extends ModelAgent>(agent: A, builder: ModelAgent | undefined, n = 0): A {
  if (!builder) return agent;
  const pool = [agent.config.model, ...Object.values(agent.config.models ?? {})];
  const others = [...new Set(pool)].filter((m): m is string => !!m && m !== builder.config.model);
  const model = n ? (others[n] ?? agent.config.model) : reviewModel(agent.config.model, builder.config.model, pool);
  return model === agent.config.model ? agent : { ...agent, config: { ...agent.config, model } };
}
