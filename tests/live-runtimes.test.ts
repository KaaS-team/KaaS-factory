// The execution contract against a real box, launcher or hosted sandbox. Each runs only when its keys
// are set (tests/live/runtimes.ts) and is skipped with the missing key's name otherwise.
import { expect, test } from "bun:test";
import { executionFor } from "../src/runtimes";
import { missingKey } from "./live/trackers";
import { LIVE_RUNTIMES } from "./live/runtimes";
import { executionContract } from "./ports/execution.contract";

for (const [name, live] of Object.entries(LIVE_RUNTIMES)) {
  const missing = missingKey(live.env, process.env);
  if (missing) test.skip(`live ${name}: skipped, ${missing} is not set`, () => {});
  else executionContract(`live ${name}`, () => executionFor(live.spec(process.env)));
}

test("the agent37 target skips naming its missing key when unset", () => {
  const live = LIVE_RUNTIMES.agent37!;
  expect(missingKey(live.env, {})).toBe("FACTORY_LIVE_AGENT37_INSTANCE");
  expect(missingKey(live.env, { FACTORY_LIVE_AGENT37_INSTANCE: "i" })).toBe("FACTORY_LIVE_AGENT37_KEY");
});
