// One PR that writes a set of files on its own branch, for changes a person proposes from the
// dashboard or the CLI (a workflow edit, `factory teach`, `factory harness scaffold`). It never
// merges, and it refuses to push a file outside the paths its caller allows.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { outsideAllowedPaths } from "./boundary";
import type { Git } from "./git";
import type { ScmPort } from "./github";

export interface ProposeDeps {
  readonly github: Pick<ScmPort, "createPr" | "findPrByHead">;
  readonly git: Pick<Git, "ensureBranchWorktree" | "commitAll" | "changedFiles" | "pushBranch">;
  readonly cloneDir: string;
  readonly workspacesDir: string;
}

export interface Proposal {
  readonly repo: string;
  readonly base: string;
  readonly branch: string;
  readonly files: Readonly<Record<string, string>>;
  readonly allowed: readonly string[];
  readonly title: string;
  readonly body: string;
}

export async function proposeFiles(deps: ProposeDeps, p: Proposal): Promise<{ prUrl: string; branch: string }> {
  const paths = Object.keys(p.files);
  const unsafe = paths.filter((f) => f.startsWith("/") || normalize(f).startsWith(".."));
  const outside = outsideAllowedPaths(paths, p.allowed);
  if (unsafe.length > 0 || outside.length > 0)
    throw new Error(`refusing to write outside ${p.allowed.join(", ")}: ${[...unsafe, ...outside].join(", ")}`);
  const dir = join(deps.workspacesDir, p.branch.replace(/\//g, "-"));
  await deps.git.ensureBranchWorktree(deps.cloneDir, dir, p.branch, p.base);
  for (const [path, text] of Object.entries(p.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  await deps.git.commitAll(dir, p.title);
  const changed = outsideAllowedPaths(await deps.git.changedFiles(dir, p.base), p.allowed);
  if (changed.length > 0) throw new Error(`refusing to push outside ${p.allowed.join(", ")}: ${changed.join(", ")}`);
  const pushed = await deps.git.pushBranch(dir, p.branch);
  if (pushed.code !== 0) throw new Error(`push of ${p.branch} failed: ${pushed.stderr.trim()}`);
  const open = await deps.github.findPrByHead(p.repo, p.branch);
  const prUrl = open
    ? open.url
    : await deps.github.createPr({ repo: p.repo, base: p.base, head: p.branch, title: p.title, body: p.body });
  return { prUrl, branch: p.branch };
}
