import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodeHostPort } from "./ports/scm";

// What init may write; only the ones on disk are staged, since release.yml is written only when absent.
const INIT_PATHS = [".factory", ".claude", ".agents", "AGENTS.md", ".github/workflows/release.yml"];

function git(dir: string, ...a: string[]): string {
  const r = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
}

function baseBranch(dir: string): string {
  try {
    return git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "");
  } catch {
    return "main";
  }
}

/** Commit the installed files on `factory/init`, push, and open the pull request through the SCM port. */
export async function openInitPr(
  dir: string,
  repo: string,
  summary: { name: string; lines: string[] },
  scm: Pick<CodeHostPort, "createPr">,
): Promise<string> {
  git(dir, "switch", "-c", "factory/init");
  git(dir, "add", "-A", ...INIT_PATHS.filter((p) => existsSync(join(dir, p))));
  git(dir, "commit", "-m", `factory: init for a ${summary.name} repo`);
  git(dir, "push", "-u", "origin", "factory/init");
  return scm.createPr({
    repo,
    base: baseBranch(dir),
    head: "factory/init",
    title: "factory: init",
    body: summary.lines.map((l) => `- ${l}`).join("\n"),
  });
}
