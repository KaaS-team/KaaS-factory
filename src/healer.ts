// A self-healing step never edits a spec in place; it writes a proposed diff to the run dir's
// `heal.diff`, and this guard refuses one that touches a non-spec file, deletes a spec, adds a skip
// or fixme, or changes anything but a locator.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./artifacts";
import { parseDiff, SKIP } from "./tamper";
import { isQaSpec } from "./visual";

export const HEAL_FILE = "heal.diff";
export const LOCATOR =
  /\b(?:getBy(?:Role|Text|Label|Placeholder|AltText|Title|TestId)|locator)\((?:[^()]|\([^()]*\))*\)/g;

const FIXME = /\.fixme\s*\(/;

const shape = (lines: readonly string[]) =>
  lines
    .map((l) => l.replace(LOCATOR, "LOCATOR").trim())
    .filter(Boolean)
    .sort()
    .join("\n");

export function healerProblems(diff: string): string[] {
  const out: string[] = [];
  for (const f of parseDiff(diff)) {
    if (!isQaSpec(f.path)) out.push(`${f.path}: the healer may only edit a Playwright spec`);
    if (f.deleted) out.push(`${f.path}: the healer deleted a spec`);
    // biome-ignore format: the mutation entry matches this line verbatim
    if (f.added.some((l) => SKIP.some((re) => re.test(l)) || FIXME.test(l))) out.push(`${f.path}: the healer marks a test skipped`);
    if (shape(f.removed) !== shape(f.added)) out.push(`${f.path}: the healer changed more than locators`);
  }
  return out;
}

export function healFindings(worktree: string, issue: number): string[] {
  const file = join(worktree, runDir(issue), HEAL_FILE);
  if (!existsSync(file)) return [];
  return healerProblems(readFileSync(file, "utf8")).map((p) => `heal.diff: ${p}`);
}
