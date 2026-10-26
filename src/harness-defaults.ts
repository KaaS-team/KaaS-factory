// The default harness: the stage skills and subagents the factory needs, bundled in template/. A
// repo's own config wins only when git tracks it unchanged: a file a stage wrote (ignored or not)
// is the agent's, never the repo's, so it cannot rewrite what the next stage reads.

import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const DEFAULTS_DIR = join(import.meta.dir, "..", "template");
const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;
const AGENT_DIRS = [".claude/agents", ".agents/agents"] as const;

export type Source = "repo" | "default";

const gitOk = (cwd: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;

// Committed and unchanged since: what the repo itself configured, not what a stage left behind.
function committed(cwd: string, path: string): boolean {
  const rel = relative(cwd, path);
  return (
    !lstatSync(path).isSymbolicLink() &&
    gitOk(cwd, ["ls-files", "--error-unmatch", "--", rel]) &&
    gitOk(cwd, ["diff", "--quiet", "HEAD", "--", rel])
  );
}

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

// The SKILL.md a stage or minion reads: the repo's under .claude/ or .agents/ (or `skillsDir`), else the default.
export function resolveSkill(
  cwd: string,
  name: string,
  skillsDir?: string,
): { path: string; source: Source } | undefined {
  for (const d of [...SKILL_DIRS, ...(skillsDir ? [skillsDir] : [])]) {
    const path = join(cwd, d, name, "SKILL.md");
    if (existsSync(path) && committed(cwd, path)) return { path, source: "repo" };
  }
  const path = join(DEFAULTS_DIR, ".claude", "skills", name, "SKILL.md");
  return existsSync(path) ? { path, source: "default" } : undefined;
}

export function resolveSubagent(cwd: string, name: string): { path: string; source: Source } | undefined {
  for (const d of AGENT_DIRS) {
    const path = join(cwd, d, `${name}.md`);
    if (existsSync(path) && committed(cwd, path)) return { path, source: "repo" };
  }
  const path = join(DEFAULTS_DIR, ".claude", "agents", `${name}.md`);
  return existsSync(path) ? { path, source: "default" } : undefined;
}

export const defaultSkills = (): string[] => listDir(join(DEFAULTS_DIR, ".claude", "skills"));
export const defaultSubagents = (): string[] =>
  listDir(join(DEFAULTS_DIR, ".claude", "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));

// Before every stage: each factory skill and subagent lands where the agent reads it, from the
// repo's committed copy, else the default. Anything else there is replaced fresh, so a stage's
// edit never reaches the next one; git ignores what is provided, so no PR carries it.
export function provideDefaults(cwd: string, skillsDir = ".claude/skills"): string[] {
  const provided: string[] = [];
  for (const name of defaultSkills()) {
    const to = join(cwd, skillsDir, name);
    const from = resolveSkill(cwd, name, skillsDir);
    if (!from || from.path === join(to, "SKILL.md")) continue;
    replaceWith(cwd, dirname(from.path), to);
    provided.push(`${skillsDir}/${name}/`);
  }
  for (const name of defaultSubagents()) {
    const to = join(cwd, ".claude", "agents", `${name}.md`);
    const from = resolveSubagent(cwd, name);
    if (!from || from.path === to) continue;
    replaceWith(cwd, from.path, to);
    provided.push(`.claude/agents/${name}.md`);
  }
  if (provided.length > 0) ignoreInGit(cwd, provided);
  return provided;
}

// The folder it lands in must resolve inside the worktree, so a planted link never sends a copy
// elsewhere; a link at `to` is removed, never followed, and links in the source are not copied.
function replaceWith(cwd: string, from: string, to: string): void {
  const root = realpathSync(cwd);
  const inside = (dir: string) => {
    let at = dir;
    while (!existsSync(at)) at = dirname(at);
    const real = realpathSync(at);
    if (real !== root && !real.startsWith(root + sep))
      throw new Error(`${relative(cwd, to)}: resolves outside the worktree`);
  };
  // Checked before mkdir too, which would otherwise follow a linked .claude out of the worktree.
  inside(dirname(to));
  mkdirSync(dirname(to), { recursive: true });
  inside(dirname(to));
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
}

function ignoreInGit(cwd: string, paths: readonly string[]): void {
  const r = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) return;
  const file = r.stdout.toString().trim();
  const have = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const lines = paths.map((p) => `/${p}`).filter((p) => !have.includes(p));
  if (lines.length === 0) return;
  if (!existsSync(dirname(file))) return;
  appendFileSync(file, `${have.length && have.at(-1) !== "" ? "\n" : ""}${lines.join("\n")}\n`);
}
