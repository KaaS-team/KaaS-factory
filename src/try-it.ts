// An optional "Try it" section for the PR body: one command and the output a reviewer should see.
// Off by default: it renders only when the run wrote try-it.json with a command, so no file, no section.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./artifacts";

export interface TryIt {
  readonly command: string;
  readonly output: string;
}

export function readTryIt(worktree: string, issue: number): TryIt | undefined {
  const file = join(worktree, runDir(issue), "try-it.json");
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<TryIt>;
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    if (!command || /[\r\n]/.test(command)) return undefined;
    return { command, output: typeof raw.output === "string" ? raw.output.trim() : "" };
  } catch {
    return undefined;
  }
}

// The fence is longer than any backtick run inside the text, so output cannot close it early.
const fence = (text: string): string => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(longest + 1);
};

export function tryItSection(t: TryIt): string {
  const block = (text: string): string => `${fence(text)}\n${text}\n${fence(text)}`;
  const lines = ["## Try it", "", block(t.command)];
  if (t.output) lines.push("", "Expected output:", "", block(t.output));
  return lines.join("\n");
}
