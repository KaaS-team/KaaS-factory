// The lines `factory explain` prints: each resolved key, its value and the level that set it.
import type { TeamApplied } from "./apply";
import { configHash } from "./hash";

function valueAt(values: Record<string, unknown>, key: string): unknown {
  let node: unknown = values;
  for (const k of key.split("."))
    node = typeof node === "object" && node !== null ? (node as Record<string, unknown>)[k] : undefined;
  return node;
}

export function explainLines(input: { issue: number; repo: string; type?: string; applied: TeamApplied }): string[] {
  const { applied } = input;
  const lines = [
    `#${input.issue} on ${input.repo}: team ${applied.team ?? "none"}, type ${input.type ?? "none"}`,
    `config_hash ${configHash(applied.config)}`,
  ];
  for (const key of Object.keys(applied.resolved.origin).sort()) {
    const line = `${key} = ${JSON.stringify(valueAt(applied.resolved.values, key))} (${applied.resolved.origin[key]})`;
    lines.push(input.type && key.startsWith(`routes.${input.type}.`) ? `${line} [this issue]` : line);
  }
  // Which kind of deny holds each marked rule, so a blocked step names hard-deny or soft-deny.
  for (const [rule, kind] of Object.entries(applied.resolved.denied).sort())
    lines.push(
      kind === "soft" && applied.resolved.lifted[rule] !== undefined
        ? `deny policy.${rule}: soft-deny, lifted by ${applied.resolved.lifted[rule]}`
        : `deny policy.${rule}: ${kind}-deny`,
    );
  for (const p of applied.resolved.problems) lines.push(`problem: ${p}`);
  return lines;
}
