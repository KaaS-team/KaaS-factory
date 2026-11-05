// Publishes the visual report (report.html and the diff images) to the factory/assets branch, so the QA
// comment can link them. Same plumbing as src/assets-branch.ts: a throwaway index, the worktree never moves.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSETS_BRANCH, type RunGit } from "./assets-branch";

export interface PublishedReport {
  readonly report: string;
  readonly diffs: readonly { readonly name: string; readonly url: string }[];
}

const base = (repo: string, issue: number) =>
  `https://raw.githubusercontent.com/${repo}/${ASSETS_BRANCH}/${issue}/report`;

// Pushes every file of `dir` to <issue>/report/ on the assets branch. Undefined when there is no report.
export async function publishVisualReport(
  git: RunGit,
  worktree: string,
  o: { repo: string; issue: number; dir: string },
): Promise<PublishedReport | undefined> {
  if (!existsSync(join(o.dir, "report.html"))) return undefined;
  const files = readdirSync(o.dir).sort();
  const remote = await git(worktree, ["ls-remote", "origin", `refs/heads/${ASSETS_BRANCH}`]);
  const head = remote ? remote.split(/\s/)[0] : undefined;
  if (head) await git(worktree, ["fetch", "--no-tags", "origin", `refs/heads/${ASSETS_BRANCH}`]);
  mkdirSync(tmpdir(), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "factory-report-"));
  try {
    const env = { GIT_INDEX_FILE: join(tmp, "index") };
    if (head) await git(worktree, ["read-tree", head], env);
    for (const f of files) {
      const blob = await git(worktree, ["hash-object", "-w", join(o.dir, f)]);
      await git(worktree, ["update-index", "--add", "--cacheinfo", `100644,${blob},${o.issue}/report/${f}`], env);
    }
    const tree = await git(worktree, ["write-tree"], env);
    const sha = await git(
      worktree,
      [
        "-c",
        "user.name=kaas-factory",
        "-c",
        "user.email=factory@users.noreply.github.com",
        "commit-tree",
        tree,
        ...(head ? ["-p", head] : []),
        "-m",
        `visual report for #${o.issue}`,
      ],
      env,
    );
    await git(worktree, ["push", "origin", `${sha}:refs/heads/${ASSETS_BRANCH}`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const url = base(o.repo, o.issue);
  return {
    report: `${url}/report.html`,
    diffs: files.filter((f) => f.endsWith(".diff.png")).map((f) => ({ name: f, url: `${url}/${f}` })),
  };
}

export function reportLinks(p: PublishedReport): string {
  return [
    "### Visual report",
    "",
    `[report.html](${p.report})`,
    ...p.diffs.map((d) => `- [${d.name}](${d.url}) ![${d.name}](${d.url})`),
  ].join("\n");
}
