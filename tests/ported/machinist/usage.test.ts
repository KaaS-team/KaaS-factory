// Ported from owainlewis/machinist@3943516 internal/runner/codex_usage_test.go:17-108 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: claude_usage_test.go:143-176 is folded in; the Go collector is a stream of Write calls; here each line goes through the preset parser and aggregateStageEvents, and the token total is in + out. The command-recognition and flag-injection cases are not ported: our presets build the command, so nothing is guessed from an arbitrary one.

import { describe, expect, test } from "bun:test";
import { aggregateStageEvents, type StageEvent } from "../../../src/executor";
import { claudePreset } from "../../../src/agents/presets/claude";
import { codexPreset } from "../../../contrib/agents/codex";
import type { AgentPreset } from "../../../src/agents/types";

// Feeds text in arbitrary chunks the way a pipe would, splitting on newlines.
function collect(preset: AgentPreset, ...chunks: string[]): { total: number | null; message?: string } {
  const events: StageEvent[] = [];
  const lines = chunks.join("").split("\n");
  for (const line of lines) events.push(...preset.parseLine(line));
  const r = aggregateStageEvents(events, 0);
  return { total: r.usageComplete === false ? null : r.tokensIn + r.tokensOut, message: r.finalMessage };
}

const codex = (...chunks: string[]) => collect(codexPreset, ...chunks);
const claude = (...chunks: string[]) => collect(claudePreset, ...chunks);

describe("codex usage", () => {
  test("reads the final structured usage across chunk boundaries", () => {
    const got = codex(
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":8,"output_tokens":2}}\n{"type":"item.completed",',
      '"item":{"type":"agent_message","text":"done"}}\n{"type":"turn.completed","usage":{"input_tokens":40,',
      '"cached_input_tokens":35,"output_tokens":3}}',
    );
    expect(got.total).toBe(43);
  });

  test.each([
    ["missing event", '{"type":"item.completed","item":{}}', 0],
    ["malformed JSON", '{"type":"turn.completed","usage":', null],
    ["missing input", '{"type":"turn.completed","usage":{"output_tokens":2}}', null],
    ["negative input", '{"type":"turn.completed","usage":{"input_tokens":-1,"output_tokens":2}}', null],
    ["overflow", '{"type":"turn.completed","usage":{"input_tokens":9223372036854775807,"output_tokens":1}}', null],
  ])("leaves invalid usage unavailable: %s", (_name, line, want) => {
    // "missing event" has no terminal event at all: nothing to trust or distrust, so zero tokens, not "unavailable".
    expect(codex(`${line}\n`).total).toBe(want);
  });

  test("uses the last completed turn, and a malformed final one makes usage unavailable", () => {
    expect(
      codex(
        '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}\n{"type":"turn.completed","usage":{"input_tokens":"invalid","output_tokens":5}}\n',
      ).total,
    ).toBeNull();
  });

  test("a truncated final completed turn invalidates usage", () => {
    expect(
      codex(
        '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}\n{"type":"turn.completed","usage":{"input_tokens":8',
      ).total,
    ).toBeNull();
  });

  test("unrelated malformed output is ignored", () => {
    expect(
      codex('{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}\n{"type":"item.completed","item":')
        .total,
    ).toBe(9);
  });

  test.each([
    [
      "result",
      claudePreset,
      '{"type":"result","usage":{"input_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}',
    ],
    ["turn.completed", codexPreset, '{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":5}}'],
  ] as const)("a nested malformed %s event is ignored", (type, preset, valid) => {
    expect(collect(preset, `${valid}\n`, `{"item":{"type":"${type}","usage":`).total).toBe(9);
  });
});

describe("claude usage", () => {
  test("reads all usage fields, cache included", () => {
    expect(
      claude(
        '{"type":"system","subtype":"init"}\n{"type":"result","usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":4}}',
      ).total,
    ).toBe(154);
  });

  test.each([
    [
      "missing field",
      '{"type":"result","usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3}}',
    ],
    ["malformed", '{"type":"result","usage":'],
    [
      "negative",
      '{"type":"result","usage":{"input_tokens":-1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}',
    ],
    [
      "fractional",
      '{"type":"result","usage":{"input_tokens":1.5,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}',
    ],
    [
      "overflow",
      '{"type":"result","usage":{"input_tokens":9223372036854775807,"cache_creation_input_tokens":1,"cache_read_input_tokens":0,"output_tokens":0}}',
    ],
    ["malformed field before type", '{"usage":invalid,"type":"result"}'],
  ])("rejects an invalid final usage: %s", (_name, line) => {
    const good =
      '{"type":"result","usage":{"input_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":3,"output_tokens":4}}';
    expect(claude(`${good}\n${line}\n`).total).toBeNull();
  });
});
