// Ported from owainlewis/machinist@3943516 internal/runner/revision.go:1-31 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the Revision shape is internal/protocol/revision.go:1-10; the previous run id is the stage that produced the work; the revision is rebuilt from the issue thread (GitHub is the state), so no run store is needed.

import { existsSync } from "node:fs";
import { COMMENT_FILENAMES, JSON_FILENAMES, runDir } from "./artifacts";
import { isHumanComment, parseChatOps } from "./chatops";
import { latestDataFor, parseDataMarkers } from "./derive";
import type { GhComment, GhIssue } from "./github";

export interface Revision {
  previousRun: string;
  previousSummary: string;
  feedback: string;
  priorFeedback: string[];
  // alias -> path relative to the run directory of the earlier output
  artifacts: Record<string, string>;
}

// Feedback is appended after everything else: braces in it are literal.
export function revisionPrompt(r: Revision | undefined, inputs: Record<string, string>): string {
  if (!r) return "";
  let out = `\n\nHuman review: revise your previous work from ${r.previousRun}.\nPrevious result: ${r.previousSummary}\n`;
  for (const feedback of r.priorFeedback) out += `Earlier review feedback: ${feedback}\n`;
  out += `Requested changes:\n${r.feedback}\n`;
  for (const alias of Object.keys(r.artifacts).sort()) {
    out += `Previous output ${JSON.stringify(r.artifacts[alias])} is available at ${JSON.stringify(inputs[alias])}\n`;
  }
  out +=
    "Use the original task requirements and the review feedback. Revise the existing work in this worktree, preserve unrelated changes, and write this stage's outputs to its usual run files. Report what changed.\n";
  return out;
}

// Every earlier trusted `/factory revise` in the thread, oldest first, so a
// second round of feedback does not make the agent forget the first.
export function priorFeedback(comments: readonly GhComment[], current: Pick<GhComment, "id">): string[] {
  const out: string[] = [];
  for (const c of comments) {
    if (c.id === current.id) break;
    if (!isHumanComment(c)) continue;
    const cmd = parseChatOps(c.body);
    if (cmd.type === "revise") out.push(cmd.text);
  }
  return out;
}

const SUMMARY_STAGES = ["verify", "build", "plan"] as const;

export function previousSummary(issue: GhIssue): string {
  const markers = parseDataMarkers(issue.comments);
  for (const stage of SUMMARY_STAGES) {
    const json = latestDataFor(markers, stage) as { summary?: unknown } | undefined;
    if (typeof json?.summary === "string" && json.summary) return `${stage}: ${json.summary}`;
  }
  return "no summary was recorded";
}

export function buildRevision(
  worktree: string,
  issue: GhIssue,
  comment: Pick<GhComment, "id">,
  feedback: string,
): Revision {
  const artifacts: Record<string, string> = {};
  for (const stage of Object.keys(JSON_FILENAMES) as (keyof typeof JSON_FILENAMES)[]) {
    for (const name of [JSON_FILENAMES[stage], COMMENT_FILENAMES[stage]]) {
      if (existsSync(`${worktree}/${runDir(issue.number)}/${name}`)) artifacts[name] = name;
    }
  }
  return {
    previousRun: `the earlier round on issue #${issue.number}`,
    previousSummary: previousSummary(issue),
    feedback,
    priorFeedback: priorFeedback(issue.comments, comment),
    artifacts,
  };
}

// `revise.md` keeps the latest feedback verbatim (the stage skills read it);
// `revision.md` is the full review history the next attempt is asked to honour.
export async function writeRevision(
  worktree: string,
  issue: GhIssue,
  comment: Pick<GhComment, "id">,
  feedback: string,
): Promise<void> {
  const dir = `${worktree}/${runDir(issue.number)}`;
  const revision = buildRevision(worktree, issue, comment, feedback);
  const inputs = Object.fromEntries(Object.keys(revision.artifacts).map((alias) => [alias, `${dir}/${alias}`]));
  await Bun.write(`${dir}/revise.md`, feedback);
  await Bun.write(`${dir}/revision.md`, revisionPrompt(revision, inputs).trimStart());
}
