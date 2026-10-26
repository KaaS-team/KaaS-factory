// The tracker contract against each vendor's real service. It runs only when a vendor's keys are set
// (tests/live/trackers.ts) and is skipped with the missing key's name otherwise, so the gate needs none.
import { test } from "bun:test";
import { makeTracker } from "../src/scm";
import { LIVE_TRACKERS, missingKey } from "./live/trackers";
import { trackerContract } from "./ports/tracker.contract";

for (const [name, live] of Object.entries(LIVE_TRACKERS)) {
  const missing = missingKey(live.env, process.env);
  if (missing) test.skip(`live ${name}: skipped, ${missing} is not set`, () => {});
  else trackerContract(`live ${name}`, () => makeTracker(live.config(process.env), process.env));
}
