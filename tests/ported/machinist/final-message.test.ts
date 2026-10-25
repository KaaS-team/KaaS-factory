// Ported from owainlewis/machinist@3943516 internal/runner/final_message_test.go:10-52 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the Go collector is replaced by the preset parsers plus aggregateStageEvents; TestExecuteRecordsTheFinalAgentMessage runs a real child through CommandExecutor instead of Go's Execute.

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../../../src/agents/executor";
import { MAX_FINAL_MESSAGE_BYTES } from "../../../src/agents/final-message";
import { claudePreset } from "../../../src/agents/presets/claude";
import { codexPreset } from "../../../src/agents/presets/codex";
import { aggregateStageEvents } from "../../../src/executor";
import type { AgentPreset } from "../../../src/agents/types";

const finalOf = (preset: AgentPreset, output: string) =>
  aggregateStageEvents(
    output.split("\n").flatMap((l) => preset.parseLine(l)),
    0,
  ).finalMessage;

test("the collector keeps the last Codex agent message", () => {
  const out =
    '{"type":"item.completed","item":{"type":"agent_message","text":"Looking at issues."}}\n' +
    '{"type":"item.completed","item":{"type":"command_execution","command":"gh issue list"}}\n' +
    '{"type":"item.completed","item":{"type":"agent_message","text":"  Labelled #496 as bug.  "}}';
  expect(finalOf(codexPreset, out)).toBe("Labelled #496 as bug.");
});

test("the collector keeps the Claude result", () => {
  const out =
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Working."}]}}\n' +
    '{"type":"result","result":"All done.","usage":{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}}\n';
  expect(finalOf(claudePreset, out)).toBe("All done.");
});

test("long messages are truncated on a character boundary", () => {
  const text = "é".repeat(MAX_FINAL_MESSAGE_BYTES);
  const got = finalOf(
    codexPreset,
    `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n`,
  )!;
  expect(got.endsWith("[truncated]")).toBe(true);
  expect(Buffer.byteLength(got)).toBeLessThanOrEqual(MAX_FINAL_MESSAGE_BYTES + "\n\n[truncated]".length);
  expect(got.startsWith("éé")).toBe(true);
  expect(got).not.toContain("�");
});

test("a real child's final agent message is recorded", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "factory-final-"));
  try {
    mkdirSync(join(cwd, ".claude/skills/factory-triage"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/factory-triage/SKILL.md"), "---\nname: factory-triage\n---\nDo it.\n");
    const output = '{"type":"item.completed","item":{"type":"agent_message","text":"Triaged 9 issues."}}\n';
    const executor = new CommandExecutor(
      { codex: { preset: "codex", command: ["sh", "-c", `cat >/dev/null; printf '%s' '${output}'`] } },
      { default: "codex" },
    );
    const result = await executor.runStage({ stage: "triage", issue: 1, cwd, maxBudgetUsd: 1 });
    expect(result.finalMessage).toBe("Triaged 9 issues.");
    expect(result.agent).toBe("codex");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
