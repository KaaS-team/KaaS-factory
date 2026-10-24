// Recorded live runs (docs/verify-an-agent.md) must replay through the preset that produced them,
// and a preset may only say `verified: true` when a real (non-synthetic) fixture backs it.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "../src/agents/presets";
import { aggregateStageEvents } from "../src/executor";

const root = join(import.meta.dir, "fixtures/agents");
const jsonl = (name: string) =>
  existsSync(join(root, name)) ? readdirSync(join(root, name)).filter((f) => f.endsWith(".jsonl")) : [];

describe("recorded agent fixtures", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const file of jsonl(name)) {
      test(`${name}/${file} replays through the ${name} preset`, () => {
        const lines = readFileSync(join(root, name, file), "utf8")
          .split("\n")
          .filter(Boolean);
        expect(lines.length).toBeGreaterThan(1);
        const parse = preset.newParser?.() ?? preset.parseLine;
        const events = lines.flatMap((l) => parse(l));
        const result = aggregateStageEvents(events, 0);
        expect(result.usageComplete).not.toBe(false);
        const meta = JSON.parse(readFileSync(join(root, name, "fixture.json"), "utf8"));
        // Cursor's stream-json carries no usage, so its cost stays "not reported".
        if (meta.reportsUsage !== false) expect(result.tokensIn + result.tokensOut).toBeGreaterThan(0);
        expect(result.finalMessage?.length ?? 0).toBeGreaterThan(0);
      });
    }
    test(`${name}: verified only with a real fixture`, () => {
      if (!preset.verified) return;
      const meta = JSON.parse(readFileSync(join(root, name, "fixture.json"), "utf8"));
      expect(meta.synthetic).toBe(false);
      expect(jsonl(name).length).toBeGreaterThan(0);
    });
  }
});
