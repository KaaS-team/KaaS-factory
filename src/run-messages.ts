// What an operator says to a run in flight. A message is appended to the issue worktree's run folder;
// the next stage prompt and the template's PreToolUse hook both read from the same offset, so each
// message reaches the agent once, before its next step.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./artifacts";
import { workspacesDir } from "./paths";

export const MESSAGES_FILE = "messages.md";
export const MESSAGES_READ = "messages.read";

export const worktreeOf = (repo: string, issue: number, env: NodeJS.ProcessEnv = process.env): string =>
  join(workspacesDir(env, repo), `issue-${issue}`);

export function appendMessage(worktree: string, issue: number, text: string, by = ""): void {
  const dir = join(worktree, runDir(issue));
  mkdirSync(dir, { recursive: true });
  const who = by ? ` ${by.replace(/\s+/g, " ")}` : "";
  appendFileSync(join(dir, MESSAGES_FILE), `- ${new Date().toISOString()}${who}: ${text.replace(/\n/g, " ")}\n`);
}

// The messages written since the last take, or undefined. The offset is in bytes, as the hook counts.
export function takeMessages(worktree: string, issue: number): string | undefined {
  const dir = join(worktree, runDir(issue));
  const file = join(dir, MESSAGES_FILE);
  if (!existsSync(file)) return undefined;
  const all = readFileSync(file);
  const seen = Number(existsSync(join(dir, MESSAGES_READ)) ? readFileSync(join(dir, MESSAGES_READ), "utf8") : 0) || 0;
  if (all.length <= seen) return undefined;
  writeFileSync(join(dir, MESSAGES_READ), String(all.length));
  return all.subarray(seen).toString("utf8").trim();
}

export const messagesSection = (text: string): string =>
  `## Messages from the operator\n\nSent while this run was going. Follow them where they apply:\n\n${text}`;
