// Ported from owainlewis/assembler@7cac671 test/outputs.test.ts:72-101 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the cases are the structured-reply ones (wrong shape rejected, typed data returned, chatter around the JSON is not accepted); the Claude envelope and --output-last-message cases have no equivalent because the runner reads the final agent message.

import { expect, test } from "bun:test";
import { parseReply } from "../../../src/agents/reply";

test("structured reply of the wrong shape is rejected", () => {
  const bad = parseReply(JSON.stringify({ approved: "yes" }));
  expect(bad.ok).toBe(false);
  expect(parseReply(JSON.stringify({ artifact: "no" })).ok).toBe(false);
  expect(parseReply(JSON.stringify({ artifact: {}, extra: 1 })).ok).toBe(false);
});

test("a structured reply validates and returns typed data", () => {
  const r = parseReply(JSON.stringify({ artifact: { approved: true }, comment: "hi" }));
  expect(r).toEqual({ ok: true, artifact: { approved: true }, comment: "hi" });
});

test("chatter around the JSON is not accepted, a fence is", () => {
  expect(parseReply('Here you go: {"artifact":{}}').ok).toBe(false);
  expect(parseReply("").ok).toBe(false);
  expect(parseReply('```json\n{"artifact":{"a":1}}\n```').ok).toBe(true);
});

test("an artifact over 16 KiB is rejected", () => {
  expect(parseReply(JSON.stringify({ artifact: { x: "a".repeat(17000) } })).ok).toBe(false);
});
