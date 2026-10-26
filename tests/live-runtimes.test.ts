// The execution contract against a real box, launcher or hosted sandbox. Each runs only when its keys
// are set (tests/live/runtimes.ts) and is skipped with the missing key's name otherwise.
import { test } from "bun:test";
import { executionFor } from "../src/runtimes";
import { missingKey } from "./live/trackers";
import { LIVE_RUNTIMES } from "./live/runtimes";
import { executionContract } from "./ports/execution.contract";

for (const [name, live] of Object.entries(LIVE_RUNTIMES)) {
  const missing = missingKey(live.env, process.env);
  if (missing) test.skip(`live ${name}: skipped, ${missing} is not set`, () => {});
  else executionContract(`live ${name}`, () => executionFor(live.spec(process.env)));
}
