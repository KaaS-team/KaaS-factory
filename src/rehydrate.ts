// Rebuilds `.factory/runs/issue-<N>/*` from the issue thread before a stage
// runs, so a worktree that has never seen this issue before (a fresh clone on
// another machine, a fresh CI job, a `factory retry` after the workspace was
// wiped) still has every earlier stage's artifact available. This is what
// makes an issue resumable from any machine (plan section "Core refactor").

import { rm } from "node:fs/promises";
import { runDir, COMMENT_FILENAMES, JSON_FILENAMES, type ArtifactStage } from "./artifacts";
import { isHumanComment, parseChatOps } from "./chatops";
import { parseDataMarkers } from "./derive";
import type { GhComment, GhIssue } from "./github";

const VISIBLE_MARKER: Partial<Record<ArtifactStage, string>> = {
  triage: "<!-- factory:triage v1",
  plan: "<!-- factory:plan v1",
  verify: "<!-- factory:verdict v1",
};

function stripDataMarker(body: string): string {
  return body.replace(/\n*<!-- factory:data \{.*?\} -->\s*$/s, "").trimEnd();
}

function findComment(comments: readonly GhComment[], needle: string) {
  for (let i = comments.length - 1; i >= 0; i -= 1) if (comments[i]!.body.includes(needle)) return comments[i];
  return undefined;
}

// The status comment carries either the build object itself (needs-info) or
// `{ build, gate }` once the runner has graded it; only the object is build.json.
function buildObject(json: unknown): unknown {
  const o = json as { build?: unknown; gate?: unknown } | null;
  return o && typeof o === "object" && "gate" in o ? (o.build ?? undefined) : json;
}

export async function rehydrate(worktree: string, issue: GhIssue): Promise<void> {
  const dir = `${worktree}/${runDir(issue.number)}`;
  await Bun.$`mkdir -p ${dir}`.quiet();

  const markers = parseDataMarkers(issue.comments);
  const stages: ArtifactStage[] = ["triage", "plan", "build", "verify"];
  for (const stage of stages) {
    const marker = [...markers].reverse().find((m) => m.stage === stage);
    if (marker !== undefined) {
      const json = stage === "build" ? buildObject(marker.json) : marker.json;
      if (json !== undefined) await Bun.write(`${dir}/${JSON_FILENAMES[stage]}`, JSON.stringify(json, null, 2));
    }
    const needle = VISIBLE_MARKER[stage];
    if (!needle) continue;
    const comment = findComment(issue.comments, needle);
    if (comment) await Bun.write(`${dir}/${COMMENT_FILENAMES[stage]}`, stripDataMarker(comment.body));
  }

  // The last reject's findings, so a later verify can tell whether each one was answered.
  const lastReject = [...markers].reverse().find((m) => m.stage === "verify" && verdictResult(m.json) === "reject");
  const findings = (lastReject?.json as { findings?: unknown } | undefined)?.findings;
  const hasFindings = Array.isArray(findings) && findings.length > 0;
  await writeOrClear(`${dir}/prior-findings.json`, hasFindings ? JSON.stringify(findings, null, 2) : undefined);

  // Human answers are the only input a build or verify can get from the operator mid-run.
  const answers: string[] = [];
  for (const c of issue.comments) {
    if (!isHumanComment(c)) continue;
    const cmd = parseChatOps(c.body);
    if (cmd.type === "answer" && cmd.text) answers.push(cmd.text);
  }
  await writeOrClear(`${dir}/operator-answers.md`, answers.length ? `${answers.join("\n\n")}\n` : undefined);
}

function verdictResult(json: unknown): unknown {
  return (json as { result?: unknown } | null)?.result;
}

// A file from an earlier rehydrate must not outlive the thread that wrote it.
async function writeOrClear(path: string, body: string | undefined): Promise<void> {
  if (body === undefined) await rm(path, { force: true });
  else await Bun.write(path, body);
}
