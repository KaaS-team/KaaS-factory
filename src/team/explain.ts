// The lines `factory explain` prints: each resolved key, its value and the level that set it.
import type { TeamApplied } from "./apply";
import type { Resolved } from "./resolve";
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

// The short names a person types for a policy rule.
const POLICY_ALIASES = ["budget_usd_month", "models", "risk_max", "protected_paths"];

// `factory config explain <key>`: the value, the level that set it, and whether the org locked it.
// `locked` is the org's locked list.
export function explainKey(
  key: string,
  resolved: Pick<Resolved, "values" | "origin">,
  locked: readonly string[],
): string[] {
  const full = POLICY_ALIASES.includes(key) ? `policy.${key}` : key;
  const leaves = Object.keys(resolved.origin)
    .filter((k) => k === full || k.startsWith(`${full}.`))
    .sort();
  if (leaves.length === 0) return [`${key} is not set at any level.`];
  const lines = leaves.map((k) => `${k} = ${JSON.stringify(valueAt(resolved.values, k))} (${resolved.origin[k]})`);
  const rule = full.startsWith("policy.") ? full.slice("policy.".length) : full;
  if (locked.includes(rule) && leaves.some((k) => resolved.origin[k] === "org")) lines.push("locked by the org");
  return lines;
}
