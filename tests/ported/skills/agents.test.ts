// Ported from owainlewis/skills@e8cadb3 internal/agents/agents_test.go:9-46 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: TestResolvedDir and TestDefaultTargets are not in the upstream file at this SHA, so the resolver and DEFAULT_TARGETS get one case each written here; the registry is built from PRESETS.

import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TARGETS, agentRegistry, skillsDirFor } from "../../../src/agent-dirs";

test("TestBuiltinAndDir", () => {
  const a = agentRegistry().get("codex");
  expect(a).toBeDefined();
  expect(a!.name).toBe("codex");
  expect(skillsDirFor(a!, "global", "/proj")).toBe(join(homedir(), ".codex/skills"));
  expect(skillsDirFor(a!, "project", "/proj")).toBe("/proj/.codex/skills");
});

test("TestOverridesAndAdditions", () => {
  const reg = agentRegistry({
    claude: { global: "~/.custom/claude" },
    myagent: { global: "~/.myagent/skills", project: ".myagent/skills" },
  });
  expect(reg.get("claude")!.global).toBe("~/.custom/claude");
  expect(reg.get("claude")!.project).toBe(".claude/skills");
  expect(reg.get("myagent")).toBeDefined();
  expect(reg.get("nope")).toBeUndefined();
});

test("the default targets all resolve", () => {
  const reg = agentRegistry();
  for (const t of DEFAULT_TARGETS) expect(reg.get(t), t).toBeDefined();
});
