// src/install-template.ts keeps AGENT_DIRS, agent -> skills dir and context file. Pin it to the presets so the copies cannot drift.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_DIRS } from "../src/install-template";
import { agentRegistry } from "../src/agent-dirs";
import { PRESETS } from "../src/agents/presets";

test("install's AGENT_DIRS has exactly the presets, with each preset's skills dir and context file", () => {
  expect(Object.keys(AGENT_DIRS).sort()).toEqual(Object.keys(PRESETS).sort());
  for (const [name, p] of Object.entries(PRESETS))
    expect(AGENT_DIRS[name]).toEqual({ skillsDir: p.skillsDir, contextFile: p.contextFile });
});

test("src/agent-dirs.ts resolves each preset to the same project dir install links", () => {
  const registry = agentRegistry();
  for (const [name, entry] of Object.entries(AGENT_DIRS)) expect(registry.get(name)?.project).toBe(entry.skillsDir);
});

test("docs/verify-an-agent.md has a section for every preset that needs verifying", () => {
  const doc = readFileSync(join(import.meta.dir, "../docs/verify-an-agent.md"), "utf8");
  for (const p of Object.values(PRESETS)) if (!p.verified) expect(doc).toContain(`### ${p.name}\n`);
});
