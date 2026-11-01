// The five test layers by time budget, from one test file while editing to the nightly runs.
// tests/test-layers.test.ts holds the workflows to them.

export type LayerId = "L0" | "L1" | "L2" | "L3" | "L4";

export interface Layer {
  readonly id: LayerId;
  readonly maxSeconds: number;
  readonly runs: string;
}

export const LAYERS: readonly Layer[] = [
  { id: "L0", maxSeconds: 10, runs: "one test file while editing" },
  { id: "L1", maxSeconds: 60, runs: "the test files a change touches, before a commit" },
  { id: "L2", maxSeconds: 180, runs: "the pull request checks" },
  { id: "L3", maxSeconds: 1200, runs: "the full gate after merge, on main" },
  { id: "L4", maxSeconds: 1800, runs: "nightly: every mutation, and every test three times" },
];

export function layerFor(seconds: number): LayerId {
  return LAYERS.find((l) => seconds < l.maxSeconds)?.id ?? "L4";
}
