// The scorer must tell the before transcripts from a clean run, or Q9 proves nothing.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreTranscript } from "../scripts/e2e-score";
import { renderEvent } from "../src/agents/executor";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "transcripts", name), "utf8");

describe("e2e-score", () => {
  for (const n of [46, 47, 73])
    test(`issue-${n} before the fix scores as failing on refused commands`, () => {
      const score = scoreTranscript(fixture(`issue-${n}-before.txt`));
      expect(score.verifyDenials).toBeGreaterThan(0);
      expect(score.misses.length).toBeGreaterThan(0);
    });

  test("issue-47 before the fix also shows the extra rounds and ScheduleWakeup", () => {
    const score = scoreTranscript(fixture("issue-47-before.txt"));
    expect(score.scheduleWakeups).toBeGreaterThan(0);
    expect(score.verifies).toBeGreaterThan(1);
  });

  const clean = [
    "=== build #9 2026-10-04T00:00:00.000Z (claude) ===",
    "> Bash",
    renderEvent({ kind: "result", text: "success", costUsd: 0.4 })!,
    "=== build exit 0 ===",
    "=== verify #9 2026-10-04T00:01:00.000Z (claude) ===",
    "> Task",
    "AC-1 pass: `bun test tests/money.test.ts` exit 1 on main, exit 0 on the branch.",
    renderEvent({ kind: "result", text: "success", costUsd: 0.3 })!,
    "=== verify exit 0 ===",
  ].join("\n");

  test("a clean run scores with no misses", () => {
    expect(scoreTranscript(clean).misses).toEqual([]);
  });

  test("a refused call the runner records in verify is a miss", () => {
    const denied = renderEvent({ kind: "result", text: "success", denials: ["Bash git show main:a > a"] })!;
    expect(denied).toContain("\ndenied Bash git show main:a > a");
    const score = scoreTranscript(clean.replace("=== verify exit 0 ===", `${denied}\n=== verify exit 0 ===`));
    expect(score.verifyDenials).toBe(1);
  });

  test("a hook refusal the agent only describes in verify is a miss", () => {
    const told = "guard-paths: this one command was refused; Bash still works.";
    expect(scoreTranscript(clean.replace("> Task", `> Task\n${told}`)).verifyDenials).toBe(1);
  });

  test("a verify with no build before it is a miss", () => {
    expect(scoreTranscript(clean.replace(/=== build #9[^\n]*/, "")).misses).toContain("1 verify rounds for 0 builds");
  });
});
