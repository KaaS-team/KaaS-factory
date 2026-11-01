// Write-back of distilled repo knowledge (#471): typed notes staged during a task are promoted into
// `.agents/knowledge/<type>.md`, one `## <task-id>: <title>` section per task, merged in place.
// It reads only the staged notes and the knowledge files: no source, no commands.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NOTE_TYPES = ["feedback", "mistake", "concern", "pattern", "decision"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface StagedNote {
  readonly type: NoteType;
  readonly title: string;
  readonly body: string;
  readonly durable: boolean;
}

export interface DistillInput {
  readonly root: string;
  readonly taskId: string;
  readonly notes: readonly StagedNote[];
  // `knowledge.distill`: false reads knowledge without writing it.
  readonly distill: boolean;
}

// The issue names `mistakes.md`; feedback has no plural.
export const fileFor = (type: NoteType): string => (type === "feedback" ? "feedback.md" : `${type}s.md`);

export const KNOWLEDGE_DIR = ".agents/knowledge";

const sectionRe = (taskId: string): RegExp =>
  new RegExp(`^## ${taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*$`, "m");

// Replaces the one section for this task in place, or appends it; other tasks' sections stay byte for byte.
export function mergeSection(existing: string, taskId: string, title: string, bodies: readonly string[]): string {
  const section = `## ${taskId}: ${title}\n\n${bodies.join("\n\n")}\n`;
  const start = sectionRe(taskId).exec(existing);
  if (!start) return existing.trim() ? `${existing.trimEnd()}\n\n${section}` : section;
  const from = start.index;
  const after = existing.slice(from + start[0].length);
  const next = /^## /m.exec(after);
  const tail = next ? `\n${after.slice(next.index)}` : "";
  return `${existing.slice(0, from)}${section}${tail}`;
}

// Returns the knowledge files it wrote, relative to the root.
export function distillKnowledge(input: DistillInput): string[] {
  if (!input.distill) return [];
  const written: string[] = [];
  for (const type of NOTE_TYPES) {
    const notes = input.notes.filter((n) => n.type === type && n.durable);
    if (notes.length === 0) continue;
    const rel = `${KNOWLEDGE_DIR}/${fileFor(type)}`;
    const path = join(input.root, rel);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const title = notes[0]?.title ?? input.taskId;
    const merged = mergeSection(
      existing,
      input.taskId,
      title,
      notes.map((n) => n.body),
    );
    if (merged === existing) continue;
    mkdirSync(join(input.root, KNOWLEDGE_DIR), { recursive: true });
    writeFileSync(path, merged);
    written.push(rel);
  }
  return written;
}
