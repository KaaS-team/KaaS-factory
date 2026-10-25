// `factory init`: turn a detected stack into .factory/config.json. The
// shipped config.example.json is the base, so every key it documents stays;
// init fills only what it read from the repo: repo, gates, setup and the
// commands the build and verify stages may run.

import { gateCount } from "./config";
import type { Stack } from "./stack";

// A config a person has filled in (no TODO, at least one gate) is theirs: init leaves it alone.
export function isFilledIn(text: string | undefined): boolean {
  if (text === undefined || text.includes("TODO")) return false;
  try {
    return gateCount(JSON.parse(text)) > 0;
  } catch {
    return false;
  }
}

export function initConfig(
  example: Record<string, unknown>,
  stack: Stack,
  repo: string | undefined,
): Record<string, unknown> {
  const agentCommands = (example.agentCommands ?? {}) as Record<string, unknown>;
  return {
    ...example,
    ...(repo ? { repo } : {}),
    gates: stack.gates,
    setup: stack.setup,
    agentCommands: { ...agentCommands, build: stack.commands, verify: stack.commands },
  };
}

export function describeStack(stack: Stack): string[] {
  return [
    `stack: ${stack.name}${stack.ci ? `, CI: ${stack.ci}` : ""}`,
    ...(stack.setup.length ? [`setup: ${stack.setup.join(" && ")}`] : []),
    ...(stack.gates.length
      ? stack.gates.map((g) => `gate ${g.name} (${g.role ?? "no role"}): ${g.cmd}`)
      : ["gates: none"]),
    ...stack.notes.map((n) => `note: ${n}`),
  ];
}
