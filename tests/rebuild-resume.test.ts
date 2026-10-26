// A rebuild is told why it came back whatever the agent: the failure tail rides every agent's
// prompt, and only an agent that kept a session (the claude preset) also forks it.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "../src/agents/presets/claude";
import { renderPrompt } from "../src/agents/prompt";

const cwd = mkdtempSync(join(tmpdir(), "factory-rebuild-"));
cpSync(join(import.meta.dir, "../template/.claude/skills"), join(cwd, ".claude/skills"), { recursive: true });
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const FAILURE = "verify: the new test passes without the fix";

describe("rebuild resume for any agent", () => {
  test("a rebuild's failure tail is in a non-claude agent's prompt", async () => {
    const prompt = await renderPrompt({ stage: "build", issue: 3, cwd, maxBudgetUsd: 1, resume: { failure: FAILURE } });
    expect(prompt).toContain("The last attempt was sent back");
    expect(prompt).toContain(FAILURE);
    expect(await renderPrompt({ stage: "build", issue: 3, cwd, maxBudgetUsd: 1 })).not.toContain(FAILURE);
  });

  test("claude with no kept session gets the tail but no --resume", () => {
    const args = claudeArgs({ stage: "build", issue: 3, cwd, maxBudgetUsd: 1, resume: { failure: FAILURE } });
    expect(args[1]).toContain(FAILURE);
    expect(args).not.toContain("--resume");
    const forked = claudeArgs({
      stage: "build",
      issue: 3,
      cwd,
      maxBudgetUsd: 1,
      resume: { sessionId: "s1", failure: FAILURE },
    });
    expect(forked).toContain("--resume");
  });
});
