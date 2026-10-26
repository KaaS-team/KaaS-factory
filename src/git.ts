// Branch claim, worktree management, and the runner's own commit. Claim is a
// real compare-and-swap: fetch the base, build a unique commit on top of it,
// and push that exact commit to create `factory/issue-N` without --force.
// Two watchers racing on the same issue will have exactly one push succeed —
// pushing the *same* base SHA twice (the old implementation) is a no-op
// fast-forward and both exits 0, which is the bug this replaces (audit
// finding #3).

import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./github";
import type { GhPr } from "./ports/scm";
import type { ChangedFile } from "./merge-policy";

async function spawnGit(args: string[], cwd?: string, env?: Record<string, string>): Promise<CommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// A bare CI runner or container has no git identity, and `commit` and
// `commit-tree` refuse to run without one. Supply a fallback only when none is
// configured, so a developer's own identity is never overridden.
export const FALLBACK_IDENTITY = ["-c", "user.name=kaas-factory", "-c", "user.email=factory@users.noreply.github.com"];

// Pure so it's unit-testable without a real repo: non-cone sparse-checkout
// wants a leading "/*" (everything) followed by a "!"-negated pattern per
// excluded path, each anchored at the repo root the same way `Bun.Glob`
// patterns already are elsewhere in this codebase (src/boundary.ts).
export function sparseCheckoutPatterns(holdoutPaths: readonly string[]): string[] {
  return ["/*", ...holdoutPaths.map((p) => `!/${p.replace(/^\/+/, "")}`)];
}

export class GitCommandRunner implements CommandRunner {
  async run(args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<CommandResult> {
    if (args[0] === "commit" || args[0] === "commit-tree" || args[0] === "rebase") {
      const name = await spawnGit(["config", "user.name"], opts?.cwd);
      const email = await spawnGit(["config", "user.email"], opts?.cwd);
      if (name.stdout.trim() === "" || email.stdout.trim() === "")
        return spawnGit([...FALLBACK_IDENTITY, ...args], opts?.cwd, opts?.env);
    }
    return spawnGit(args, opts?.cwd, opts?.env);
  }
}

// The one branch naming for an issue's work, and its inverse. A tracker that is
// not GitHub links an issue to its PR through this name (src/scm.ts).
export function issueBranch(issue: number): string {
  return `factory/issue-${issue}`;
}

export function issueOfBranch(head: string): number | undefined {
  const n = /^factory\/issue-(\d+)$/.exec(head)?.[1];
  return n ? Number(n) : undefined;
}

// The issue a PR works on: the factory's own branch name first, else the one
// issue the PR closes. Undefined for a PR that is not about exactly one issue.
export function issueOfPr(pr: Pick<GhPr, "headRefName" | "closingIssuesReferences">): number | undefined {
  const own = issueOfBranch(pr.headRefName);
  if (own !== undefined) return own;
  const closes = pr.closingIssuesReferences ?? [];
  return closes.length === 1 ? closes[0]!.number : undefined;
}

export class Git {
  constructor(private readonly runner: CommandRunner = new GitCommandRunner()) {}

  branchName(issue: number): string {
    return issueBranch(issue);
  }

  // Returns true if this call won the claim (push succeeded), false if
  // another watcher already claimed it first (or the base tag doesn't exist).
  async claim(cloneDir: string, issue: number, base: string): Promise<boolean> {
    const branch = this.branchName(issue);
    await this.runner.run(["fetch", "origin", base], { cwd: cloneDir });
    const baseRev = await this.runner.run(["rev-parse", `origin/${base}`], { cwd: cloneDir });
    const baseSha = baseRev.stdout.trim();
    if (!baseSha) return false;

    const runnerId = `${process.env.HOSTNAME ?? "runner"}-${process.pid}-${Date.now()}`;
    const commitTree = await this.runner.run(
      ["commit-tree", `${baseSha}^{tree}`, "-p", baseSha, "-m", `factory: claim #${issue} by ${runnerId}`],
      { cwd: cloneDir },
    );
    const claimSha = commitTree.stdout.trim();
    if (!claimSha) return false;

    // No --force: if `branch` already exists, this only succeeds when
    // claimSha is a fast-forward of it — which it never is, since its parent
    // is origin/base, not whatever another claimant already pushed.
    const push = await this.runner.run(["push", "origin", `${claimSha}:refs/heads/${branch}`], { cwd: cloneDir });
    return push.code === 0;
  }

  // Idempotent: safe to call again for a worktree that's already registered
  // (a restart on the same machine) or for a branch another machine already
  // claimed (a fresh clone resuming an in-flight issue) — both are how the
  // runner recovers after a crash (audit finding #21).
  async ensureWorktree(cloneDir: string, worktreeDir: string, issue: number): Promise<void> {
    const branch = this.branchName(issue);
    await this.runner.run(["fetch", "origin", branch], { cwd: cloneDir });
    const list = await this.runner.run(["worktree", "list", "--porcelain"], { cwd: cloneDir });
    if (list.stdout.includes(`worktree ${worktreeDir}\n`)) return;
    await this.runner.run(["worktree", "add", worktreeDir, branch], { cwd: cloneDir });
  }

  /** @deprecated use ensureWorktree */
  async addWorktree(cloneDir: string, worktreeDir: string, issue: number): Promise<void> {
    return this.ensureWorktree(cloneDir, worktreeDir, issue);
  }

  // Holdout tests (plan v2.11.0 item C): hides the configured paths from the
  // worktree by content, not just by convention, so no stage's agent — Claude,
  // Codex or Cursor alike — can ever read them, regardless of what a prompt
  // asks for. A no-op when there is nothing to hide, so a repo with holdout
  // off never pays for a sparse-checkout it doesn't use.
  async excludeFromSparseCheckout(worktreeDir: string, holdoutPaths: readonly string[]): Promise<void> {
    if (holdoutPaths.length === 0) return;
    await this.runner.run(["sparse-checkout", "init", "--no-cone"], { cwd: worktreeDir });
    await this.runner.run(["sparse-checkout", "set", ...sparseCheckoutPatterns(holdoutPaths)], { cwd: worktreeDir });
  }

  // Generic (non-issue) counterpart to ensureWorktree, for `factory learn`
  // (plan v2.10.0 item 4): reuses `branch` if origin already has one (a
  // same-day run resuming after a restart), otherwise branches it fresh off
  // origin/base, since there is no issue number to derive the name from.
  async ensureBranchWorktree(cloneDir: string, worktreeDir: string, branch: string, base: string): Promise<void> {
    await this.runner.run(["fetch", "origin", base], { cwd: cloneDir });
    const list = await this.runner.run(["worktree", "list", "--porcelain"], { cwd: cloneDir });
    if (list.stdout.includes(`worktree ${worktreeDir}\n`)) return;
    const remote = await this.runner.run(["ls-remote", "--heads", "origin", branch], { cwd: cloneDir });
    if (remote.stdout.trim()) {
      await this.runner.run(["fetch", "origin", branch], { cwd: cloneDir });
      await this.runner.run(["worktree", "add", worktreeDir, branch], { cwd: cloneDir });
    } else {
      await this.runner.run(["worktree", "add", "-b", branch, worktreeDir, `origin/${base}`], { cwd: cloneDir });
    }
  }

  async removeWorktree(cloneDir: string, worktreeDir: string): Promise<void> {
    await this.runner.run(["worktree", "remove", "--force", worktreeDir], { cwd: cloneDir });
  }

  // Stages and commits everything in the worktree except `.factory/runs/`
  // (the stage handoff files, never meant to land in the target repo) using
  // a pathspec exclusion, which works the same in a linked worktree as in the
  // main checkout. Returns false when there was nothing to commit. Before
  // this, nobody committed at all: the build skill's own text said "the
  // runner commits", but the runner only pushed (audit finding #4).
  async commitAll(worktreeDir: string, message: string): Promise<boolean> {
    await this.runner.run(["add", "-A", "--", ".", ":!.factory/runs"], { cwd: worktreeDir });
    const status = await this.runner.run(["status", "--porcelain", "--", ".", ":!.factory/runs"], { cwd: worktreeDir });
    if (!status.stdout.trim()) return false;
    const result = await this.runner.run(["commit", "-m", message], { cwd: worktreeDir });
    return result.code === 0;
  }

  // Regular push only; the guard hook and settings.json refuse --force and merge.
  async push(worktreeDir: string, issue: number): Promise<CommandResult> {
    return this.pushBranch(worktreeDir, this.branchName(issue));
  }

  // Generic (non-issue) counterpart to push, for `factory learn`'s branch.
  async pushBranch(worktreeDir: string, branch: string): Promise<CommandResult> {
    return this.runner.run(["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktreeDir });
  }

  // The merge queue's moves (src/merge-queue.ts): the base's tip after a fetch, a rebase of the PR
  // head that aborts on conflict, and a push that refuses unless the branch is still at `expected`.
  async fetchBase(worktreeDir: string, base: string): Promise<string> {
    await this.runner.run(["fetch", "-q", "origin", base], { cwd: worktreeDir });
    return (await this.runner.run(["rev-parse", `origin/${base}`], { cwd: worktreeDir })).stdout.trim();
  }

  async rebaseOnto(
    worktreeDir: string,
    onto: string,
    head: string,
  ): Promise<{ ok: true; head: string } | { ok: false; detail: string }> {
    const reset = await this.runner.run(["reset", "-q", "--keep", head], { cwd: worktreeDir });
    if (reset.code !== 0) return { ok: false, detail: reset.stderr.trim() || "the worktree is not at the PR head" };
    const rebase = await this.runner.run(["rebase", "-q", onto], { cwd: worktreeDir });
    if (rebase.code !== 0) {
      await this.runner.run(["rebase", "--abort"], { cwd: worktreeDir });
      return { ok: false, detail: (rebase.stdout + rebase.stderr).trim().slice(-500) };
    }
    return { ok: true, head: (await this.runner.run(["rev-parse", "HEAD"], { cwd: worktreeDir })).stdout.trim() };
  }

  async pushRebased(worktreeDir: string, branch: string, expected: string): Promise<CommandResult> {
    const lease = `--force-with-lease=refs/heads/${branch}:${expected}`;
    return this.runner.run(["push", lease, "origin", `HEAD:refs/heads/${branch}`], { cwd: worktreeDir });
  }

  // The tree of the working directory, not of HEAD: uncommitted edits count,
  // so gate evidence cannot pass for a tree the agent has since changed. A
  // throwaway index keeps the real one untouched; `.factory/runs` is the
  // handoff dir (gate.json lives there) and is left out. The copy starts from
  // the real index so skip-worktree (holdout) entries stay as committed.
  async treeHash(worktreeDir: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "factory-index-"));
    try {
      const env = { GIT_INDEX_FILE: join(dir, "index") };
      const index = (
        await this.runner.run(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: worktreeDir })
      ).stdout.trim();
      copyFileSync(index, env.GIT_INDEX_FILE);
      await this.runner.run(["add", "-A", "--", ".", ":!.factory/runs"], { cwd: worktreeDir, env });
      const result = await this.runner.run(["write-tree"], { cwd: worktreeDir, env });
      return result.stdout.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async hasCommits(worktreeDir: string, base: string): Promise<boolean> {
    const result = await this.runner.run(["rev-list", `origin/${base}..HEAD`, "--count"], { cwd: worktreeDir });
    return Number(result.stdout.trim() || "0") > 0;
  }

  // The patch of this branch against its base, for a reviewer that has no tools.
  async diff(worktreeDir: string, base: string): Promise<string> {
    return (await this.runner.run(["diff", `origin/${base}...HEAD`], { cwd: worktreeDir })).stdout;
  }

  // Files changed on this branch versus its base, regardless of how they
  // were changed — the check that catches a Bash-made edit the Edit/Write
  // guard hook never saw (audit finding #12).
  async changedFiles(worktreeDir: string, base: string): Promise<string[]> {
    const result = await this.runner.run(["diff", "--name-only", `origin/${base}...HEAD`], { cwd: worktreeDir });
    return result.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // File-by-file added/deleted line counts, for merge-policy's autoEligible
  // (src/merge-policy.ts). A binary file reports "-" for both counts in
  // `--numstat`; those count as a changed file but add no lines.
  // The diff of `head` (the PR head the merge will match, not whatever the worktree holds)
  // against the base. --no-renames lists a rename as a delete and an add, so both paths meet
  // the path globs; --raw gives each file's new mode; numstat's "-" marks a binary file.
  async diffStat(worktreeDir: string, base: string, head = "HEAD"): Promise<ChangedFile[]> {
    const range = `origin/${base}...${head}`;
    const [numstat, raw] = await Promise.all([
      this.runner.run(["diff", "--numstat", "--no-renames", "-z", range], { cwd: worktreeDir }),
      this.runner.run(["diff", "--raw", "--no-renames", "-z", range], { cwd: worktreeDir }),
    ]);
    if (numstat.code !== 0 || raw.code !== 0)
      throw new Error(`git diff ${range} failed: ${numstat.stderr || raw.stderr}`);
    const modes = new Map<string, string>();
    const rawParts = raw.stdout.split("\0");
    for (let i = 0; i + 1 < rawParts.length; i += 2) modes.set(rawParts[i + 1]!, rawParts[i]!.split(" ")[1]!);
    return numstat.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [add, del, ...rest] = entry.split("\t");
        const path = rest.join("\t");
        const binary = add === "-" && del === "-";
        return {
          path,
          additions: Number(add) || 0,
          deletions: Number(del) || 0,
          mode: modes.get(path) ?? "100644",
          ...(binary ? { binary } : {}),
        };
      });
  }
}
