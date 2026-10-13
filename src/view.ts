// `factory view`: the live window for one issue. The executor keeps the agent's raw
// stdout in a stream file beside the plain transcript; this renders it in colour,
// with edit diffs and test results, for a person watching the tmux window.

import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { plain } from "./display";

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[97m" };
const paint = (color: string, text: string) => `${color}${text}${C.reset}`;

const STAGE_COLOR: Record<string, string> = { triage: C.cyan, plan: C.blue, build: C.yellow, verify: C.magenta, pr: C.green };
const TOOL_COLOR: Record<string, string> = { Read: C.cyan, Edit: C.yellow, Write: C.yellow, MultiEdit: C.yellow, Bash: C.magenta, Grep: C.cyan, Glob: C.cyan, Agent: C.blue };
const DIFF_LINES = 12;
const RESULT_LINES = 5;
const BANNER_WIDTH = 56;
// A gate summary or a test runner's totals; the line decides the colour, not the exit code.
const FAIL_LINE = /\b[1-9]\d* fail\b|\(fail\)|\bFAIL\b|status=RED|\b[Ee]rror\b|✗/;
const PASS_LINE = /\b0 fail\b|\b\d+ pass\b|\(pass\)|status=GREEN|\[ok\s*\]|✓/;

// The marker lines the executor writes around each stage; everything else is the agent's own output.
export type StreamMarker = { type: "factory_stage"; stage: string; issue: number; at: string; agent: string } | { type: "factory_exit"; stage: string; code: number; reason?: string };

interface Block {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function lines(text: string): string[] {
  return plain(text.replace(/\r/g, "")).split("\n");
}

// One parse of the stream, drawn twice: in colour for the tmux window (render) and as cards
// on the dashboard's run page (items). Neither can show the agent doing something the other hides.
export type Tone = "fail" | "pass" | "plain";
export interface Diff { removed: string[]; added: string[]; removedMore: number; addedMore: number }
export type StreamItem =
  | { kind: "stage"; stage: string; issue: number }
  | { kind: "exit"; stage: string; ok: boolean; code: number; reason?: string }
  | { kind: "say"; text: string; nested: boolean }
  | { kind: "tool"; name: string; target: string; nested: boolean; diff?: Diff }
  | { kind: "result"; ok: boolean; rows: { text: string; tone: Tone }[]; nested: boolean }
  | { kind: "done"; ms?: number; costUsd?: number }
  | { kind: "raw"; text: string };

// Lines both sides share at the start and end are context, not change.
export function diffParts(before: string, after: string): Diff {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  return { removed: removed.slice(0, DIFF_LINES), added: added.slice(0, DIFF_LINES), removedMore: Math.max(0, removed.length - DIFF_LINES), addedMore: Math.max(0, added.length - DIFF_LINES) };
}

function paintDiff(d: Diff): string[] {
  const side = (rows: string[], more: number, sign: string, color: string) => [...rows.map((r) => paint(color, `    ${sign} ${r}`)), ...(more ? [paint(C.dim, `    … ${more} more lines`)] : [])];
  return [...side(d.removed, d.removedMore, "-", C.red), ...side(d.added, d.addedMore, "+", C.green)];
}

export function diffLines(before: string, after: string): string[] {
  return paintDiff(diffParts(before, after));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text) : "")).join("\n");
  return "";
}

function banner(stage: string, issue: number): string[] {
  const color = STAGE_COLOR[stage] ?? C.white;
  const label = ` ${stage.toUpperCase()}  #${issue}`;
  const rule = "─".repeat(BANNER_WIDTH);
  return ["", paint(color, `╭${rule}╮`), paint(color, `│${C.bold}${label.padEnd(BANNER_WIDTH)}${C.reset}${color}│`), paint(color, `╰${rule}╯`)];
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const TONE_COLOR: Record<Tone, string> = { fail: C.red, pass: C.green, plain: C.dim };

function paintItem(item: StreamItem): string[] {
  switch (item.kind) {
    case "stage":
      return banner(item.stage, item.issue);
    case "exit":
      return [paint(item.ok ? C.green : C.red, `${item.ok ? "✓" : "✗"} ${item.stage} exit ${item.code}${item.reason ? ` (${item.reason})` : ""}`)];
    case "say":
      return item.text.split("\n").map((r) => `${item.nested ? "  " : ""}${paint(C.white, r)}`);
    case "tool": {
      const head = `${item.nested ? "  " : ""}${paint(TOOL_COLOR[item.name] ?? C.white, "●")} ${paint(C.bold, item.name)} ${item.target}`.trimEnd();
      return [head, ...(item.diff ? paintDiff(item.diff) : [])];
    }
    case "result": {
      const pad = item.nested ? "  " : "";
      const mark = item.ok ? paint(C.green, "✓") : paint(C.red, "✗");
      return item.rows.map((r, i) => `${pad}    ${i === 0 ? mark : " "} ${paint(TONE_COLOR[r.tone], r.text)}`);
    }
    case "done":
      return [paint(C.dim, `  done${item.ms != null ? ` in ${duration(item.ms)}` : ""}${item.costUsd != null ? `  $${item.costUsd.toFixed(2)}` : ""}`)];
    case "raw":
      return [item.text];
  }
}

// Stateful across lines: a tool result only says which call it answers, so the call is remembered.
export class StreamView {
  private cwd = "";
  private readonly calls = new Map<string, string>();

  private rel(path: string): string {
    return this.cwd ? path.split(`${this.cwd}/`).join("") : path;
  }

  private target(name: string, input: Record<string, unknown> = {}): string {
    const pick = name === "Agent" || name === "Task" ? input.description : (input.file_path ?? input.command ?? input.pattern ?? input.skill ?? input.path ?? input.url ?? input.query);
    if (typeof pick !== "string") return "";
    const first = this.rel(plain(pick.trim().split("\n")[0] ?? ""));
    return first.length > 100 ? `${first.slice(0, 99)}…` : first;
  }

  private toolUse(b: Block, nested: boolean): StreamItem[] {
    const name = b.name ?? "tool";
    if (b.id) this.calls.set(b.id, name);
    if (name === "TodoWrite") return [];
    const input = b.input ?? {};
    const item: StreamItem = { kind: "tool", name, target: this.target(name, b.input), nested };
    if (name === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") item.diff = diffParts(input.old_string, input.new_string);
    if (name === "Write" && typeof input.content === "string") item.diff = diffParts("", input.content);
    return [item];
  }

  // Only command output is worth reading in the window; a Read's file contents are not.
  private toolResult(b: Block, nested: boolean): StreamItem[] {
    const name = b.tool_use_id ? this.calls.get(b.tool_use_id) : undefined;
    if (name !== "Bash") return b.is_error ? [{ kind: "result", ok: false, rows: [{ text: lines(resultText(b.content))[0] ?? "", tone: "fail" }], nested }] : [];
    const rows = lines(resultText(b.content)).filter((r) => r.trim() !== "").slice(-RESULT_LINES);
    return [{ kind: "result", ok: !b.is_error, nested, rows: rows.map((text) => ({ text, tone: FAIL_LINE.test(text) ? "fail" : PASS_LINE.test(text) ? "pass" : "plain" })) }];
  }

  items(line: string): StreamItem[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return [{ kind: "raw", text: plain(line) }];
    }
    if (typeof event !== "object" || event === null) return [{ kind: "raw", text: plain(line) }];
    const type = event.type;
    if (type === "factory_stage") return [{ kind: "stage", stage: String(event.stage), issue: Number(event.issue) }];
    if (type === "factory_exit") {
      const code = Number(event.code);
      return [{ kind: "exit", stage: String(event.stage), code, ok: code === 0 && !event.reason, ...(event.reason ? { reason: plain(String(event.reason)) } : {}) }];
    }
    if (type === "system" && event.subtype === "init" && typeof event.cwd === "string") this.cwd = event.cwd;
    if (type === "result") return [{ kind: "done", ...(typeof event.duration_ms === "number" ? { ms: event.duration_ms } : {}), ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}) }];
    const message = event.message as { content?: unknown } | undefined;
    if ((type !== "assistant" && type !== "user") || !Array.isArray(message?.content)) return [];
    const nested = typeof event.parent_tool_use_id === "string";
    return (message.content as Block[]).flatMap((b): StreamItem[] => {
      if (b.type === "text" && b.text && type === "assistant") return [{ kind: "say", text: lines(b.text).join("\n"), nested }];
      if (b.type === "tool_use") return this.toolUse(b, nested);
      if (b.type === "tool_result") return this.toolResult(b, nested);
      return [];
    });
  }

  render(line: string): string[] {
    return this.items(line).flatMap(paintItem);
  }
}

const POLL_MS = 250;

// `tail -F` for a stream file that may not exist yet: whole lines only, from the start.
export async function followStream(file: string, write: (text: string) => void, opts: { follow: boolean; signal?: AbortSignal }): Promise<void> {
  const view = new StreamView();
  let offset = 0;
  let pending = "";
  const decoder = new TextDecoder();
  for (;;) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const fd = openSync(file, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          pending += decoder.decode(buf, { stream: true });
        } finally {
          closeSync(fd);
        }
        const rows = pending.split("\n");
        pending = rows.pop() ?? "";
        const out = rows.flatMap((r) => view.render(r));
        if (out.length) write(`${out.join("\n")}\n`);
      }
    }
    if (!opts.follow || opts.signal?.aborted) return;
    await Bun.sleep(POLL_MS);
  }
}
