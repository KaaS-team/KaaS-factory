// `factory init`: turn a detected stack into .factory/config.json. The
// shipped config.example.json is the base, so every key it documents stays;
// init fills only what it read from the repo: repo, gates, setup, the commands
// the build and verify stages may run, and the read commands every stage may run.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateCount } from "./config";
import { CHARTER_PATH } from "./context";
import { toolchainOf } from "./images";
import { readCommands, type Stack } from "./stack";

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
  const toolchain = toolchainOf(stack.name);
  return {
    ...example,
    ...(repo ? { repo } : {}),
    ...(toolchain ? { toolchain } : {}),
    gates: stack.gates,
    setup: stack.setup,
    agentCommands: { ...agentCommands, read: readCommands(stack), build: stack.commands, verify: stack.commands },
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

// The charter names what init read; the risk tiers and protected paths stay TODO for a person,
// so doctor still fails until they are written. An edited charter is never overwritten.
export function initCharter(template: string, stack: Stack, repo: string | undefined): string {
  const toolchain = toolchainOf(stack.name);
  const read = [
    "## Stack",
    "",
    `\`factory init\` read this repo as **${stack.name}**${toolchain ? `, toolchain \`${toolchain}\`` : ""}.`,
    ...stack.gates.map((g) => `- gate \`${g.name}\`: \`${g.cmd}\``),
    "",
  ].join("\n");
  const named = repo ? template.replace("# TODO: <repo> factory charter", `# ${repo} factory charter`) : template;
  return named.replace("## Risk tiers", `${read}\n## Risk tiers`);
}

export function writeCharter(dir: string, template: string, stack: Stack, repo: string | undefined): boolean {
  const path = join(dir, CHARTER_PATH);
  if (existsSync(path) && readFileSync(path, "utf8") !== template) return false;
  writeFileSync(path, initCharter(template, stack, repo));
  return true;
}
