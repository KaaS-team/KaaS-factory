// Ported from owainlewis/assembler@7cac671 src/index.ts:228-255 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the reply is an envelope {artifact, comment, question} that the runner writes as the stage's files; validation is the stage validators in artifacts.ts, not zod; a code fence around the JSON is tolerated.
// A read-only agent cannot write its artifacts, so it returns them as its final
// message. This turns that message into the files the runner already reads.

import { mkdir, writeFile } from "node:fs/promises";
import { type ArtifactStage, COMMENT_FILENAMES, JSON_FILENAMES, MAX_STEP_JSON_BYTES, runDir } from "../artifacts";

export type Reply =
  | { ok: true; artifact: Record<string, unknown>; comment?: string; question?: string }
  | { ok: false; reason: string };

export function parseReply(text: string | undefined): Reply {
  if (!text?.trim()) return { ok: false, reason: "the read-only agent returned no final message" };
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1]! : text.trim());
  } catch (e) {
    return { ok: false, reason: `the final message is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, reason: "the final message is not a JSON object" };
  const o = value as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !["artifact", "comment", "question"].includes(k));
  if (extra) return { ok: false, reason: `the final message has unknown field "${extra}"` };
  if (typeof o.artifact !== "object" || o.artifact === null || Array.isArray(o.artifact))
    return { ok: false, reason: 'the final message has no "artifact" object' };
  for (const k of ["comment", "question"])
    if (o[k] !== undefined && typeof o[k] !== "string") return { ok: false, reason: `"${k}" must be a string` };
  const artifact = o.artifact as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(artifact)) > MAX_STEP_JSON_BYTES)
    return { ok: false, reason: `the artifact is over ${MAX_STEP_JSON_BYTES} bytes` };
  return {
    ok: true,
    artifact,
    ...(o.comment ? { comment: o.comment as string } : {}),
    ...(o.question ? { question: o.question as string } : {}),
  };
}

// Writes the envelope's parts where the runner reads them. Returns the reason
// when the reply is unusable, so the caller can fail the stage with it.
export async function writeReply(
  cwd: string,
  issue: number,
  stage: ArtifactStage,
  text: string | undefined,
): Promise<string | undefined> {
  const reply = parseReply(text);
  if (!reply.ok) return reply.reason;
  const dir = `${cwd}/${runDir(issue)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${JSON_FILENAMES[stage]}`, `${JSON.stringify(reply.artifact)}\n`);
  if (reply.comment) await writeFile(`${dir}/${COMMENT_FILENAMES[stage]}`, reply.comment);
  if (reply.question) await writeFile(`${dir}/question-comment.md`, reply.question);
  return undefined;
}
