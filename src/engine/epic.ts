// Epic support: an issue whose body is a checklist of child issues ships as one PR. Pure helpers
// (title, commit messages, task table, checklist) plus the two calls that touch a tracker.

import { cell } from "../acceptance";
import type { Git } from "../git";
import type { TrackerPort } from "../ports/scm";

const MAX_TITLE = 72;
const ITEM = /^\s*[-*] \[( |x|X)\] (.*)$/;

export interface ChecklistItem {
  done: boolean;
  text: string;
  issues: number[];
}

export function checklist(body: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of body.split("\n")) {
    const m = ITEM.exec(line);
    if (!m) continue;
    const text = m[2]!;
    items.push({ done: m[1] !== " ", text, issues: [...text.matchAll(/#(\d+)/g)].map((r) => Number(r[1])) });
  }
  return items;
}

export function epicProgress(body: string): { done: number; total: number } | undefined {
  const items = checklist(body);
  if (!items.length) return undefined;
  return { done: items.filter((i) => i.done).length, total: items.length };
}

export function childIssues(body: string, self: number): number[] {
  const all = checklist(body).flatMap((i) => i.issues);
  return [...new Set(all)].filter((n) => n !== self).sort((a, b) => a - b);
}

export function closingLine(self: number, children: readonly number[]): string {
  return `Closes #${self}${children.map((n) => `, closes #${n}`).join("")}`;
}

export function tickAll(body: string): string {
  return body.replace(/^(\s*[-*] )\[ \]/gm, "$1[x]");
}

export function conventionalType(triageType: string | undefined): string {
  if (triageType === "bug" || triageType === "security") return "fix";
  if (triageType === "docs") return "docs";
  if (triageType === "dependency") return "chore";
  return "feat";
}

// The directory the change lives in, one level below src/ or tests/; none when files span several.
export function scopeOf(files: readonly string[]): string | undefined {
  const parts = files.map((f) => f.split("/"));
  if (!parts.length) return undefined;
  const depth = ["src", "tests"].includes(parts[0]![0]!) && parts[0]!.length > 2 ? 2 : 1;
  const heads = new Set(parts.map((p) => (p.length > depth ? p.slice(0, depth).join("/") : "")));
  const [only] = [...heads];
  if (heads.size !== 1 || !only) return undefined;
  return only.split("/").pop();
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function clip(head: string, subject: string, tail: string): string {
  const room = MAX_TITLE - head.length - tail.length;
  const cut = subject.length > room ? `${subject.slice(0, Math.max(room - 1, 1)).trimEnd()}…` : subject;
  return `${head}${cut}${tail}`;
}

export function conventionalTitle(type: string, scope: string | undefined, subject: string, ref: string): string {
  return clip(`${type}${scope ? `(${scope})` : ""}: `, lowerFirst(subject.trim()), ` (${ref})`);
}

export interface EpicTask {
  readonly id: string;
  readonly title: string;
  readonly files: readonly string[];
}

export function taskCommitMessage(task: EpicTask, goal: string, type: string, ref: string): string {
  const scope = scopeOf(task.files);
  const subject = clip(`${type}${scope ? `(${scope})` : ""}: `, lowerFirst(task.title), "");
  return `${subject}\n\n${goal.trim()}\n\nTask ${task.id} of ${ref}.`;
}

export function issueCommitMessage(
  title: string,
  goal: string,
  files: readonly string[],
  type: string,
  ref: string,
): string {
  return `${conventionalTitle(type, scopeOf(files), title, ref)}\n\n${goal.trim()}`;
}

export function renderTaskTable(
  tasks: readonly EpicTask[],
  criteria: readonly { id: string; task?: string }[],
  verified: readonly { id: string; status: string }[] | undefined,
): string {
  if (tasks.length < 2) return "";
  const rows = tasks.map((t) => {
    const acs = criteria
      .filter((c) => c.task === t.id)
      .map((c) => `${c.id} ${verified?.find((v) => v.id === c.id)?.status ?? "not run"}`);
    const files = t.files.map((f) => `\`${f}\``).join(", ");
    return `| ${cell(`${t.id}: ${t.title}`)} | ${cell(files)} | ${cell(acs.join(", ") || "none")} |`;
  });
  return ["## Tasks", "", "| Task | Files | Acceptance |", "| --- | --- | --- |", ...rows].join("\n");
}

type Committer = Pick<Git, "commitAll" | "commitPaths">;

// One commit per task in plan order, so the history reads as the plan; a single task or a plan
// without tasks stays one commit. A closing commitAll catches files no task named.
export async function commitByTask(
  git: Committer,
  worktree: string,
  input: {
    tasks: readonly EpicTask[];
    goal: string;
    type: string;
    ref: string;
    title: string;
    files: readonly string[];
  },
): Promise<void> {
  const { tasks, goal, type, ref } = input;
  const whole = issueCommitMessage(input.title, goal, input.files, type, ref);
  if (tasks.length < 2) {
    await git.commitAll(worktree, whole);
    return;
  }
  for (const task of tasks) await git.commitPaths(worktree, task.files, taskCommitMessage(task, goal, type, ref));
  await git.commitAll(worktree, whole);
}

// After the epic's PR merges: close the children and tick the checklist. A failure is logged and never
// stops the merge bookkeeping.
export async function settleEpic(
  tracker: Pick<TrackerPort, "closeIssue" | "editIssueBody">,
  repo: string,
  issue: { number: number; body: string },
): Promise<void> {
  const children = childIssues(issue.body, issue.number);
  if (!children.length) return;
  for (const n of children)
    await tracker.closeIssue(repo, n).catch((err) => console.error(`closing epic child #${n} failed:`, err));
  const ticked = tickAll(issue.body);
  if (ticked !== issue.body && tracker.editIssueBody)
    await tracker
      .editIssueBody(repo, issue.number, ticked)
      .catch((err) => console.error(`ticking epic #${issue.number} failed:`, err));
}
