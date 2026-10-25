// `factory learn` (plan v2.10.0 item 4): batches pending retro proposals into
// one PR on a daily learning branch. Deterministic, no agent: the retro stage
// already made the judgment (what lesson, what skill edit); this just
// durably exposes it for human review. It never auto-merges.

import { outsideAllowedPaths } from "./boundary";
import { capLessons, LESSONS_PATH } from "./context";
import type { Git } from "./git";
import type { ScmPort } from "./github";
import type { FactoryState, RetroRow } from "./state";

// The one exemption from config.protectedPaths, and only for this branch
// kind: a learning PR may touch memory and skill-proposal files, nothing else.
export const LEARNING_ALLOWED_PATHS = [".factory/memory/**", ".claude/skills/**"] as const;

export interface LearnDeps {
  readonly github: ScmPort;
  readonly git: Git;
  readonly state: FactoryState;
  readonly cloneDir: string;
  readonly workspacesDir: string;
}

export interface LearnResult {
  readonly batched: number;
  readonly prUrl?: string;
  readonly branch?: string;
}

export function branchNameFor(when: Date): string {
  const y = when.getUTCFullYear();
  const m = String(when.getUTCMonth() + 1).padStart(2, "0");
  const d = String(when.getUTCDate()).padStart(2, "0");
  return `factory/learning-${y}${m}${d}`;
}

async function readIfExists(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : "";
}

// Appends new lessons to the existing file and re-applies the same cap
// buildContextPack's reader enforces (src/context.ts), so the file this
// writes is never the thing that forces a trim at read time.
async function appendLessons(worktreeDir: string, rows: readonly RetroRow[]): Promise<void> {
  const lines = rows.filter((r) => r.lesson).map((r) => `- ${r.lesson} (issue #${r.issue})`);
  if (lines.length === 0) return;
  const path = `${worktreeDir}/${LESSONS_PATH}`;
  const existing = (await readIfExists(path)).trim();
  const merged = existing ? `${existing}\n${lines.join("\n")}\n` : `${lines.join("\n")}\n`;
  await Bun.write(path, capLessons(merged));
}

// One proposal file per named skill, never the real SKILL.md: incorporating
// the wording change is left to a human during PR review.
async function appendProposedEdits(worktreeDir: string, rows: readonly RetroRow[]): Promise<void> {
  const skillNames = new Set(
    rows.filter((r): r is RetroRow & { skill_name: string } => Boolean(r.skill_name)).map((r) => r.skill_name),
  );
  for (const name of skillNames) {
    const path = `${worktreeDir}/.claude/skills/${name}/PROPOSED_EDITS.md`;
    const entries = rows
      .filter((r) => r.skill_name === name && r.skill_edit)
      .map((r) => `## From issue #${r.issue} (${r.outcome})\n\n${r.skill_edit}\n`);
    if (entries.length === 0) continue;
    const existing = (await readIfExists(path)).trim();
    const merged = existing ? `${existing}\n\n${entries.join("\n")}` : entries.join("\n");
    await Bun.write(path, `${merged.trim()}\n`);
  }
}

function buildPrBody(rows: readonly RetroRow[]): string {
  const lines = rows.map(
    (r) => `- #${r.issue} (${r.outcome}): ${r.lesson ?? `skill edit proposed for \`${r.skill_name}\``}`,
  );
  return [
    `Batches ${rows.length} pending retro proposal(s) into repo-local memory and skill-edit proposals.`,
    "",
    ...lines,
    "",
    "Nothing here is applied automatically; review the lesson and any `PROPOSED_EDITS.md` files before merging.",
  ].join("\n");
}

// Idempotent per day: a second run the same day reuses the branch and PR, and
// only ever batches rows still pending (markLearned stops a row being batched
// twice). Throws, without pushing or marking anything learned, if the batch
// would touch anything outside LEARNING_ALLOWED_PATHS: the one case that
// should never happen since only src/state.ts and this file write these
// paths, but is checked anyway as defense in depth (mirrors
// touchesProtectedPath's use in watch.ts).
export async function runLearn(
  deps: LearnDeps,
  repo: string,
  base: string,
  now: Date = new Date(),
): Promise<LearnResult> {
  const pending = deps.state.pendingLessons(repo);
  if (pending.length === 0) return { batched: 0 };

  const branch = branchNameFor(now);
  const worktreeDir = `${deps.workspacesDir}/${branch.replace(/\//g, "-")}`;
  await deps.git.ensureBranchWorktree(deps.cloneDir, worktreeDir, branch, base);

  await appendLessons(worktreeDir, pending);
  await appendProposedEdits(worktreeDir, pending);

  const committed = await deps.git.commitAll(worktreeDir, `factory: batch ${pending.length} retro proposal(s)`);
  if (!committed) return { batched: 0 };

  const changed = await deps.git.changedFiles(worktreeDir, base);
  const outside = outsideAllowedPaths(changed, LEARNING_ALLOWED_PATHS);
  if (outside.length > 0) {
    throw new Error(`factory learn: refusing to push outside its allowed paths: ${outside.join(", ")}`);
  }

  await deps.git.pushBranch(worktreeDir, branch);

  const existingPr = await deps.github.findPrByHead(repo, branch);
  const prUrl = existingPr
    ? existingPr.url
    : await deps.github.createPr({
        repo,
        base,
        head: branch,
        title: `factory: learning batch ${branch.replace("factory/learning-", "")}`,
        body: buildPrBody(pending),
      });

  deps.state.markLearned(
    pending.map((r) => r.id),
    now.toISOString(),
  );
  return { batched: pending.length, prUrl, branch };
}
