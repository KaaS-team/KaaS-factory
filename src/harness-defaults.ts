// The default harness: the stage skills and subagents the factory needs, bundled in template/. A
// repo's own config wins: a skill or subagent it has under .claude/, .agents/ or the agent's own
// skills dir is used as is, and a default fills only a name the repo left out.

import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULTS_DIR = join(import.meta.dir, "..", "template");
const SKILL_DIRS = [".claude/skills", ".agents/skills"] as const;
const AGENT_DIRS = [".claude/agents", ".agents/agents"] as const;

export type Source = "repo" | "default";

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
    if (existsSync(path)) return { path, source: "repo" };
  }
  const path = join(DEFAULTS_DIR, ".claude", "skills", name, "SKILL.md");
  return existsSync(path) ? { path, source: "default" } : undefined;
}

export function resolveSubagent(cwd: string, name: string): { path: string; source: Source } | undefined {
  for (const d of AGENT_DIRS) {
    const path = join(cwd, d, `${name}.md`);
    if (existsSync(path)) return { path, source: "repo" };
  }
  const path = join(DEFAULTS_DIR, ".claude", "agents", `${name}.md`);
  return existsSync(path) ? { path, source: "default" } : undefined;
}

export const defaultSkills = (): string[] => listDir(join(DEFAULTS_DIR, ".claude", "skills"));
export const defaultSubagents = (): string[] =>
  listDir(join(DEFAULTS_DIR, ".claude", "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));

// Before a stage runs: put each factory skill and subagent where the agent reads it (`skillsDir`,
// default .claude/skills), from the repo's .agents/ copy when it has one, else the default. A copy
// already there is the repo's and stays; git ignores the rest, so no PR carries them.
export function provideDefaults(cwd: string, skillsDir = ".claude/skills"): string[] {
  const provided: string[] = [];
  for (const name of defaultSkills()) {
    if (existsSync(join(cwd, skillsDir, name, "SKILL.md"))) continue;
    const from = resolveSkill(cwd, name, skillsDir);
    if (!from) continue;
    cpSync(dirname(from.path), join(cwd, skillsDir, name), { recursive: true });
    provided.push(`${skillsDir}/${name}/`);
  }
  for (const name of defaultSubagents()) {
    const to = join(cwd, ".claude", "agents", `${name}.md`);
    const from = existsSync(to) ? undefined : resolveSubagent(cwd, name);
    if (!from) continue;
    cpSync(from.path, to);
    provided.push(`.claude/agents/${name}.md`);
  }
  if (provided.length > 0) ignoreInGit(cwd, provided);
  return provided;
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
