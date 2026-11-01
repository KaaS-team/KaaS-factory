// Distilled knowledge write-back (#471): one section per task, merged in place, off by switch.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { distillKnowledge, type StagedNote } from "../src/knowledge-distill";

function repo(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "distill-"));
}
const mistake = (body: string, durable = true): StagedNote => ({ type: "mistake", title: "CI broke", body, durable });
const read = (root: string, f: string): string => readFileSync(join(root, ".agents/knowledge", f), "utf8");

describe("distillKnowledge", () => {
  test("one mistake note adds one section to mistakes.md and no other file", () => {
    const root = repo();
    expect(distillKnowledge({ root, taskId: "T-1", notes: [mistake("Run make fast.")], distill: true })).toEqual([
      ".agents/knowledge/mistakes.md",
    ]);
    expect(readdirSync(join(root, ".agents/knowledge"))).toEqual(["mistakes.md"]);
    expect(read(root, "mistakes.md")).toBe("## T-1: CI broke\n\nRun make fast.\n");
  });

  test("a second run on the same task id merges into its section and leaves others alone", () => {
    const root = repo();
    mkdirSync(join(root, ".agents/knowledge"), { recursive: true });
    writeFileSync(join(root, ".agents/knowledge/mistakes.md"), "## T-0: old\n\nkeep me\n");
    distillKnowledge({ root, taskId: "T-1", notes: [mistake("first")], distill: true });
    distillKnowledge({ root, taskId: "T-1", notes: [mistake("second")], distill: true });
    expect(read(root, "mistakes.md")).toBe("## T-0: old\n\nkeep me\n\n## T-1: CI broke\n\nsecond\n");
  });

  test("a section in the middle is replaced without touching the one after it", () => {
    const root = repo();
    mkdirSync(join(root, ".agents/knowledge"), { recursive: true });
    writeFileSync(join(root, ".agents/knowledge/mistakes.md"), "## T-1: a\n\nold\n\n## T-2: b\n\nkeep\n");
    distillKnowledge({ root, taskId: "T-1", notes: [mistake("new")], distill: true });
    expect(read(root, "mistakes.md")).toBe("## T-1: CI broke\n\nnew\n\n## T-2: b\n\nkeep\n");
  });

  test("with the switch off no knowledge file changes", () => {
    const root = repo();
    expect(distillKnowledge({ root, taskId: "T-1", notes: [mistake("x")], distill: false })).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a note that is not durable is not promoted", () => {
    const root = repo();
    expect(distillKnowledge({ root, taskId: "T-1", notes: [mistake("x", false)], distill: true })).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });
});
