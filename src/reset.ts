// `factory reset --repo <r> [--dry-run]`: put the target repo back to its
// seeded state, any time, idempotently (plan section 10). Every action is
// data first (planReset), so `--dry-run` and the real run share one plan and
// tests can assert on the plan without touching a real `gh`.

import { readdir } from "node:fs/promises";
import type { CommandRunner, ScmPort } from "./github";
import { LABELS } from "./labels";

export type ResetActionKind =
  | "close-pr"
  | "delete-branch"
  | "drop-commit"
  | "force-main"
  | "close-issue"
  | "create-issue"
  | "ensure-label"
  | "wipe-worktrees"
  | "wipe-state";

export interface ResetAction {
  readonly kind: ResetActionKind;
  readonly detail: string;
  readonly data?: Record<string, unknown>;
}

export interface ResetContext {
  readonly repo: string;
  readonly cloneDir: string;
  readonly baselineTag: string;
  readonly base: string; // the branch force-pushed back to the baseline (config.base)
  readonly issuesDir: string; // target's .factory/issues/*.md
  readonly workspacesDir: string;
  readonly statePath: string;
  // Close every open issue, not just the factory's and the seeded ones (a sandbox that holds nothing else).
  readonly allIssues?: boolean;
  // config.resettable, opt-in per repo. A live repo (lwp-website) never sets
  // this, so a stray `factory reset`/`rebaseline` cannot force-push it back
  // to a baseline tag (plan v2.6.2 item 2). Defaults closed: omitting the
  // field refuses, the same as an explicit `false`.
  readonly resettable?: boolean;
}

export class NotResettableError extends Error {
  constructor(repo: string) {
    super(
      `${repo} is not resettable: set "resettable": true in .factory/config.json to allow \`factory reset\`/\`rebaseline\` on it`,
    );
  }
}

export interface ResetDeps {
  readonly github: ScmPort;
  readonly git: CommandRunner;
}

export interface IssueSeed {
  readonly title: string;
  readonly type: string;
  readonly labels: string[];
  readonly body: string;
}

// `.factory/issues/*.md`: optional `---` frontmatter (title, type, labels: a,
// b) followed by the issue body. A file with no frontmatter uses its first
// heading as the title.
export function parseIssueSeed(text: string): IssueSeed {
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let title = "";
  let type = "feature";
  let labels: string[] = [];
  let body = text;
  if (fmMatch) {
    const [, front, rest] = fmMatch;
    body = (rest ?? "").trim();
    for (const line of (front ?? "").split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, rawValue] = m;
      const value = (rawValue ?? "").trim().replace(/^"(.*)"$/, "$1");
      if (key === "title") title = value;
      else if (key === "type") type = value;
      else if (key === "labels")
        labels = value
          .replace(/^\[(.*)\]$/, "$1")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    }
  }
  if (!title) {
    const heading = body.match(/^#\s+(.+)$/m);
    title = heading ? heading[1]!.trim() : "Untitled";
  }
  if (labels.length === 0) labels = [type];
  return { title, type, labels, body: body.trim() };
}

export async function readIssueSeeds(issuesDir: string): Promise<IssueSeed[]> {
  let entries: string[];
  try {
    entries = await readdir(issuesDir);
  } catch {
    return [];
  }
  const seeds: IssueSeed[] = [];
  for (const name of entries.filter((n) => n.endsWith(".md")).sort()) {
    const text = await Bun.file(`${issuesDir}/${name}`).text();
    seeds.push(parseIssueSeed(text));
  }
  return seeds;
}

function parseRemoteBranches(lsRemoteOutput: string): string[] {
  return lsRemoteOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/heads/"))
    .map((ref) => ref.replace("refs/heads/", ""));
}

// One line per commit on origin/<base> that the baseline tag does not contain.
export async function commitsAheadOfTag(deps: ResetDeps, ctx: ResetContext): Promise<string[]> {
  await deps.git.run(["fetch", "origin", ctx.base], { cwd: ctx.cloneDir });
  const log = await deps.git.run(["log", "--oneline", `${ctx.baselineTag}..origin/${ctx.base}`], { cwd: ctx.cloneDir });
  return log.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function checked(deps: ResetDeps, ctx: ResetContext, args: string[]): Promise<void> {
  const r = await deps.git.run(args, { cwd: ctx.cloneDir });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (${r.code}): ${r.stderr.trim()}`);
}

// Move the baseline tag to origin/<base>: the "keep this merge" command.
export async function rebaseline(deps: ResetDeps, ctx: ResetContext, dryRun: boolean): Promise<string[]> {
  if (!ctx.resettable) throw new NotResettableError(ctx.repo);
  const moved = await commitsAheadOfTag(deps, ctx);
  if (!dryRun && moved.length) {
    await checked(deps, ctx, ["tag", "-f", ctx.baselineTag, `origin/${ctx.base}`]);
    await checked(deps, ctx, ["push", "--force", "origin", `refs/tags/${ctx.baselineTag}`]);
  }
  return moved;
}

export async function planReset(deps: ResetDeps, ctx: ResetContext): Promise<ResetAction[]> {
  const actions: ResetAction[] = [];

  // Rewinding the base goes first: a protected branch can refuse the force
  // push, and nothing destructive should have run by then.
  const tag = await deps.git.run(["rev-parse", ctx.baselineTag], { cwd: ctx.cloneDir });
  const sha = tag.stdout.trim();
  // Checked before any plan is made: a missing tag must not leave a half-done reset.
  if (tag.code !== 0 || !sha) throw new Error(`baseline tag ${ctx.baselineTag} not found in ${ctx.cloneDir}`);
  // Show what the force push throws away, so a merged setup change is
  // noticed before it is lost (keep it with `factory rebaseline`).
  for (const commit of await commitsAheadOfTag(deps, ctx)) {
    actions.push({ kind: "drop-commit", detail: commit });
  }
  actions.push({
    kind: "force-main",
    detail: `${ctx.base} <- ${sha || `<tag ${ctx.baselineTag} not found>`}`,
    data: { sha },
  });

  const prs = await deps.github.listPrs(ctx.repo, { state: "open" });
  for (const pr of prs.filter((p) => p.headRefName.startsWith("factory/"))) {
    actions.push({ kind: "close-pr", detail: `#${pr.number} (${pr.headRefName})`, data: { number: pr.number } });
  }

  const lsRemote = await deps.git.run(["ls-remote", "--heads", "origin", "factory/*"], { cwd: ctx.cloneDir });
  for (const branch of parseRemoteBranches(lsRemote.stdout)) {
    actions.push({ kind: "delete-branch", detail: branch, data: { branch } });
  }

  // Only the factory's own issues (a factory:* label) and the seeded ones are closed; anything else belongs to a human.
  const seeds = await readIssueSeeds(ctx.issuesDir);
  const seeded = new Set(seeds.map((seed) => seed.title));
  const openIssues = await deps.github.listOpenIssues(ctx.repo);
  for (const issue of openIssues) {
    const ours = issue.labels.some((l) => l.name.startsWith("factory:")) || seeded.has(issue.title);
    if (!ours && !ctx.allIssues) continue;
    actions.push({ kind: "close-issue", detail: `#${issue.number} ${issue.title}`, data: { number: issue.number } });
  }

  // Labels first: a fresh repo has none, and creating a labelled issue fails without them.
  for (const label of LABELS) {
    actions.push({ kind: "ensure-label", detail: label.name, data: { label } });
  }

  for (const seed of seeds) {
    actions.push({ kind: "create-issue", detail: seed.title, data: { seed } });
  }

  actions.push({ kind: "wipe-worktrees", detail: ctx.workspacesDir });
  actions.push({ kind: "wipe-state", detail: ctx.statePath });

  return actions;
}

async function applyAction(deps: ResetDeps, ctx: ResetContext, action: ResetAction): Promise<void> {
  switch (action.kind) {
    case "close-pr":
      await deps.github.closePr(ctx.repo, action.data!.number as number);
      return;
    case "delete-branch":
      await checked(deps, ctx, ["push", "origin", "--delete", action.data!.branch as string]);
      return;
    case "force-main": {
      const sha = action.data!.sha as string;
      if (!sha) throw new Error(`baseline tag ${ctx.baselineTag} not found in ${ctx.cloneDir}`);
      await checked(deps, ctx, ["push", "--force", "origin", `${sha}:refs/heads/${ctx.base}`]);
      return;
    }
    case "drop-commit":
      return; // informational: the force-main push below is what drops it
    case "close-issue":
      await deps.github.closeIssue(ctx.repo, action.data!.number as number);
      return;
    case "create-issue": {
      const seed = action.data!.seed as IssueSeed;
      await deps.github.createIssue(ctx.repo, seed.title, seed.body, seed.labels);
      return;
    }
    case "ensure-label": {
      const label = action.data!.label as { name: string; color: string; description: string };
      await deps.github.ensureLabel(ctx.repo, label.name, label.color, label.description);
      return;
    }
    case "wipe-worktrees":
      await Bun.$`rm -rf ${action.detail}`.quiet();
      return;
    case "wipe-state":
      // SQLite runs in WAL mode; a leftover -wal or -shm next to a fresh file corrupts it.
      await Bun.$`rm -rf ${action.detail} ${action.detail}-wal ${action.detail}-shm`.quiet();
      return;
  }
}

export interface ResetSummary {
  readonly actions: ResetAction[];
  readonly dryRun: boolean;
}

export async function reset(deps: ResetDeps, ctx: ResetContext, dryRun: boolean): Promise<ResetSummary> {
  if (!ctx.resettable) throw new NotResettableError(ctx.repo);
  const actions = await planReset(deps, ctx);
  if (!dryRun) {
    for (const action of actions) {
      await applyAction(deps, ctx, action);
      console.log(`factory reset: ${action.kind} ${action.detail}`);
    }
  }
  return { actions, dryRun };
}
