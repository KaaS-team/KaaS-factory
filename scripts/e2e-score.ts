// Scores issue transcripts for the verify failure in docs/decisions/stage-shell-shapes.md.
// Usage: bun scripts/e2e-score.ts <transcript.log>...  Prints JSON; exits 1 on any miss.
// The fixtures in tests/fixtures/transcripts are the before state and must fail.

import { readFileSync } from "node:fs";

export interface Score {
  readonly builds: number;
  readonly verifies: number;
  readonly verifyDenials: number;
  readonly couldNotVerify: number;
  readonly scheduleWakeups: number;
  readonly misses: string[];
}

const HEADER = /^=== (\w+) #\d+ .*===$/;
// "denied <tool> <input>" is the runner's line for a refused call, hook blocks
// included (measured); the phrases catch refusals agents only describe.
const DENIAL = /^denied |was denied|were denied|denied the bash|don't ask mode|command was refused/i;
const NO_VERDICT = /could not verify|couldn't verify|can't give a verdict|could not confirm/i;

export function scoreTranscript(text: string): Score {
  let stage = "";
  let builds = 0,
    verifies = 0,
    verifyDenials = 0,
    couldNotVerify = 0,
    scheduleWakeups = 0;
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      stage = header[1]!;
      if (stage === "build") builds++;
      if (stage === "verify") verifies++;
      continue;
    }
    if (line === "> ScheduleWakeup") scheduleWakeups++;
    if (stage !== "verify") continue;
    if (DENIAL.test(line)) verifyDenials++;
    if (NO_VERDICT.test(line)) couldNotVerify++;
  }
  const misses: string[] = [];
  if (verifies === 0) misses.push("never reached verify");
  if (verifies > builds) misses.push(`${verifies} verify rounds for ${builds} builds`);
  if (verifyDenials) misses.push(`${verifyDenials} refused-command lines in verify`);
  if (couldNotVerify) misses.push(`${couldNotVerify} could-not-verify lines in verify`);
  if (scheduleWakeups) misses.push(`${scheduleWakeups} ScheduleWakeup calls`);
  return { builds, verifies, verifyDenials, couldNotVerify, scheduleWakeups, misses };
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("usage: bun scripts/e2e-score.ts <transcript.log>...");
  const scores = Object.fromEntries(files.map((f) => [f, scoreTranscript(readFileSync(f, "utf8"))]));
  console.log(JSON.stringify(scores, null, 2));
  if (Object.values(scores).some((s) => s.misses.length)) process.exit(1);
}
