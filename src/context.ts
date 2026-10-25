// Plan v2.7.0 item 3, narrowed in v3.0: what an agent would otherwise spend
// tool calls discovering, assembled once, up front, and only what its stage
// uses (STAGE_PACK). AGENTS.md is held only when the agent's own context file
// does not already load it. Capped at 64 KiB; whatever does not fit is named
// in the pack, never silently truncated mid-file.

import type { PlanArtifact } from "./artifacts";
import { readStageArtifacts } from "./artifacts";
import type { StageName } from "./executor";
import { stripFrontmatter } from "./agents/prompt";
import { readdirSync } from "node:fs";

export const MAX_CONTEXT_PACK_BYTES = 64 * 1024;

// v2.10.0 item 2: repo-local memory across runs. Capped well under the
// context pack's own budget so a growing lessons file can never crowd out
// AGENTS.md or the plan's own files; `factory learn` (v2.10.0 item 4) enforces
// the same cap when it appends, so reading here should rarely need to trim.
export const LESSONS_PATH = ".factory/memory/lessons.md";
export const MAX_LESSONS_BYTES = 8 * 1024;
export const CHARTER_PATH = ".factory/charter.md";

type SectionKey = "conventions" | "charter" | "lessons" | "skillsIndex" | "routeSkills" | "architecture" | "planFiles";

// v3.0 token diet: every stage used to get every section. pr gets nothing
// (its inputs are the run's own artifacts), retro only the lessons it must
// not repeat, and the plan stage a one-line-per-skill index instead of
// reading every SKILL.md in full.
export const STAGE_PACK: Record<StageName, readonly SectionKey[]> = {
  triage: ["conventions", "charter", "lessons"],
  plan: ["conventions", "charter", "lessons", "skillsIndex", "architecture"],
  build: ["conventions", "charter", "lessons", "routeSkills", "architecture", "planFiles"],
  verify: ["conventions", "routeSkills"],
  pr: [],
  retro: ["lessons"],
};

export interface PackOptions {
  // Skills the issue's route adds (config routes[type].skills).
  readonly skills?: readonly string[];
  // The agent's context file (CLAUDE.md, AGENTS.md, ...). When it is AGENTS.md
  // or imports it with `@AGENTS.md`, the agent already has it: holding it here
  // too sent the same text twice per stage.
  readonly contextFile?: string;
}

interface Section {
  readonly label: string;
  readonly body: string;
}

async function readOptional(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  return text.trim() ? text : undefined;
}

// Keeps the most recent lessons (the tail of the file, whole lines only) when
// over the cap, since a newer lesson is more likely to still apply than an
// older one it may have superseded.
export function capLessons(raw: string): string {
  if (Buffer.byteLength(raw) <= MAX_LESSONS_BYTES) return raw;
  const lines = raw.split("\n");
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const bytes = Buffer.byteLength(`${line}\n`);
    if (used + bytes > MAX_LESSONS_BYTES) break;
    kept.unshift(line);
    used += bytes;
  }
  return `Older lessons dropped for the ${MAX_LESSONS_BYTES / 1024} KiB lessons-file cap.\n\n${kept.join("\n")}`;
}

async function planFiles(cwd: string, issue: number): Promise<readonly string[]> {
  const { json } = await readStageArtifacts(cwd, issue, "plan");
  const files = (json as Partial<PlanArtifact> | undefined)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

export async function contextFileLoadsAgentsMd(cwd: string, contextFile: string | undefined): Promise<boolean> {
  if (!contextFile) return false;
  if (contextFile === "AGENTS.md") return true;
  const text = await readOptional(`${cwd}/${contextFile}`);
  return text !== undefined && /^@AGENTS\.md\s*$/m.test(text);
}

// `- name: description` per repo skill (factory-* excluded), from frontmatter only.
export async function skillsIndex(cwd: string): Promise<string> {
  let names: string[];
  try {
    names = readdirSync(`${cwd}/.claude/skills`)
      .filter((n) => !n.startsWith("factory-"))
      .sort();
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const name of names) {
    const text = await readOptional(`${cwd}/.claude/skills/${name}/SKILL.md`);
    if (!text?.startsWith("---\n")) continue;
    const front = text.slice(4, text.indexOf("\n---", 3));
    const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
    if (description) lines.push(`- ${name}: ${description}`);
  }
  return lines.join("\n");
}

async function sections(stage: StageName, issue: number, cwd: string, opts: PackOptions): Promise<Section[]> {
  const out: Section[] = [];
  const want = new Set(STAGE_PACK[stage]);

  if (want.has("conventions") && !(await contextFileLoadsAgentsMd(cwd, opts.contextFile))) {
    const agentsMd = await readOptional(`${cwd}/AGENTS.md`);
    if (agentsMd) out.push({ label: "AGENTS.md", body: agentsMd.trim() });
  }

  if (want.has("charter")) {
    const charter = await readOptional(`${cwd}/${CHARTER_PATH}`);
    if (charter) out.push({ label: CHARTER_PATH, body: charter.trim() });
  }

  if (want.has("lessons")) {
    const lessons = await readOptional(`${cwd}/${LESSONS_PATH}`);
    if (lessons) out.push({ label: "lessons learned", body: capLessons(lessons).trim() });
  }

  if (want.has("skillsIndex")) {
    const index = await skillsIndex(cwd);
    if (index) out.push({ label: "repo skills index", body: index });
  }

  if (want.has("routeSkills")) {
    for (const name of opts.skills ?? []) {
      const body = await readOptional(`${cwd}/.claude/skills/${name}/SKILL.md`);
      if (body) out.push({ label: `skill: ${name}`, body: stripFrontmatter(body).trim() });
    }
  }

  if (want.has("architecture")) {
    const architectureMd = await readOptional(`${cwd}/ARCHITECTURE.md`);
    if (architectureMd) out.push({ label: "ARCHITECTURE.md", body: architectureMd.trim() });
  }

  // Empty until a plan exists.
  if (want.has("planFiles")) {
    for (const path of await planFiles(cwd, issue)) {
      const body = await readOptional(`${cwd}/${path}`);
      if (body) out.push({ label: `file: ${path}`, body: body.trim() });
    }
  }

  return out;
}

// Sections are added highest-priority first (repo conventions and skills
// ahead of the plan's own files), and the budget is enforced in that same
// order: the first sections over budget get dropped, not the file content
// inside a kept section truncated.
function assemble(built: readonly Section[]): string {
  const header = "## Context pack\n\n";
  let used = Buffer.byteLength(header);
  const kept: Section[] = [];
  const dropped: string[] = [];
  for (const s of built) {
    const block = `### ${s.label}\n\n${s.body}\n\n`;
    const bytes = Buffer.byteLength(block);
    if (used + bytes > MAX_CONTEXT_PACK_BYTES) {
      dropped.push(s.label);
      continue;
    }
    used += bytes;
    kept.push(s);
  }
  if (!kept.length && !dropped.length) return "";
  const droppedNote = dropped.length ? `Dropped for the 64 KiB context-pack budget: ${dropped.join(", ")}.\n\n` : "";
  return `${header}${droppedNote}${kept.map((s) => `### ${s.label}\n\n${s.body}\n\n`).join("")}`.trim();
}

// "" means there is nothing to add: callers skip injecting it rather than
// appending an empty "## Context pack" header.
export async function buildContextPack(
  stage: StageName,
  issue: number,
  cwd: string,
  opts: PackOptions = {},
): Promise<string> {
  return assemble(await sections(stage, issue, cwd, opts));
}
