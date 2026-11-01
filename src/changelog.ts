// The `changelog` step kind: a runner-only step, no agent and no tokens. It adds one line for the
// issue under "## Unreleased" in CHANGELOG.md, commits that file alone and pushes. Rerunning it for
// the same issue adds nothing, so a revise that re-enters the workflow never doubles the line.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlanArtifact } from "./artifacts";
import type { StepCtx, StepResult, StepType } from "./engine/steps";
import { readRunJson } from "./engine/verdict-rules";

export const CHANGELOG_FILE = "CHANGELOG.md";
const UNRELEASED = "## Unreleased";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

// "- <goal> (#N)", the plan's one-line goal or else the issue title.
export function changelogLine(issueNumber: number, goal: string | undefined, title: string): string {
  return `- ${oneLine(goal || title)} (#${issueNumber})`;
}

// Puts the line at the top of the Unreleased section, creating the section when absent. A line
// already naming the issue in that section is left alone.
export function addChangelogEntry(text: string, line: string, issueNumber: number): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === UNRELEASED);
  if (at < 0) {
    const title = text.startsWith("# ");
    const head = title ? [lines[0], ""] : [];
    const rest = (title ? lines.slice(1) : lines).join("\n").replace(/^\n+/, "");
    return `${head.join("\n")}${title ? "\n" : ""}${UNRELEASED}\n\n${line}\n${rest ? `\n${rest}` : ""}`;
  }
  let end = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const marker = `(#${issueNumber})`;
  if (lines.slice(at + 1, end).some((l) => l.endsWith(marker))) return text;
  const skip = lines[at + 1] === "" ? 1 : 0;
  const tail = lines.slice(at + 1 + skip);
  return [...lines.slice(0, at + 1), "", line, ...(tail[0]?.startsWith("## ") ? [""] : []), ...tail].join("\n");
}

export const changelogStep: StepType = {
  async run(sc: StepCtx): Promise<StepResult> {
    const { deps, issue, worktree } = sc;
    const plan = readRunJson<PlanArtifact>(worktree, issue.number, "plan.json");
    const file = join(worktree, CHANGELOG_FILE);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "# Changelog\n";
    const after = addChangelogEntry(before, changelogLine(issue.number, plan?.goal, issue.title), issue.number);
    if (after === before && existsSync(file)) return { kind: "next", facts: { ok: true, changed: false } };
    writeFileSync(file, after);
    const committed = await deps.git.commitPaths(worktree, [CHANGELOG_FILE], `docs: changelog for #${issue.number}`);
    if (committed) await deps.git.push(worktree, issue.number);
    return { kind: "next", facts: { ok: true, changed: committed } };
  },
};
