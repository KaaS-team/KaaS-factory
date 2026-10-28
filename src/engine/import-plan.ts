// Imports a plan written in the issue itself, so plan costs nothing. Every problem is collected,
// so an author fixes the body once.

import type { Risk } from "../artifacts";
import { type IssueMeta, parseMeta, topoOrder } from "../core/schedule";

// The bundled workflow a planned issue runs; watch.ts picks it from the body, not from a route.
export const PLANNED_WORKFLOW = "planned-to-pr";
export const PLANNED_MARKER = "<!-- factory:planned v1 -->";

export interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly files: string[];
  readonly model: string;
  readonly steps: string[];
  readonly deps: string[];
}
export interface PlannedMutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly test: string;
}
export interface PlannedCriterion {
  readonly id: string;
  readonly text: string;
  readonly commands: string[];
  readonly task: string;
}
export interface PlannedIssue {
  readonly goal: string;
  readonly tasks: PlannedTask[];
  readonly tests: string[];
  readonly mutations: PlannedMutation[];
  readonly criteria: PlannedCriterion[];
  readonly nonGoals: string[];
  readonly files: { path: string; isNew: boolean }[];
  readonly risk: Risk;
  readonly model: string;
  readonly meta: IssueMeta;
}

export function isPlannedBody(body: string): boolean {
  return body.trimStart().startsWith(PLANNED_MARKER);
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function sections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of body.split(/^## /m).slice(1)) {
    const nl = p.indexOf("\n");
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    out.set(head.toLowerCase().split(":")[0]!.trim(), nl < 0 ? "" : p.slice(nl + 1));
  }
  return out;
}

const ticks = (line: string): string[] => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
const bullets = (text: string | undefined): string[] =>
  (text ?? "")
    .split("\n")
    .filter((l) => /^\s*-\s/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, ""));

function parseTasks(text: string, problems: string[]): PlannedTask[] {
  const tasks: PlannedTask[] = [];
  for (const chunk of text.split(/^### /m).slice(1)) {
    const lines = chunk.split("\n");
    const head = /^(T\d+):\s*(.+)$/.exec(lines[0]!.trim());
    if (!head) {
      problems.push(`Change: "### ${lines[0]!.trim()}" is not "### T<n>: <title>".`);
      continue;
    }
    const files = ticks(lines.find((l) => /^Files:/i.test(l)) ?? "");
    const model = /^Model:\s*(\w+)/im.exec(chunk)?.[1]?.toLowerCase() ?? "";
    if (!files.length) problems.push(`${head[1]} lists no Files.`);
    if (!["haiku", "sonnet", "opus"].includes(model))
      problems.push(`${head[1]} has no Model of haiku, sonnet or opus.`);
    const steps = lines.filter((l) => /^\d+\.\s/.test(l)).map((l) => l.replace(/^\d+\.\s*/, ""));
    if (!steps.length) problems.push(`${head[1]} has no numbered steps.`);
    const deps = (/^Deps:\s*(.+)$/im.exec(chunk)?.[1] ?? "").split(/[\s,]+/).filter((t) => t && t !== "none");
    for (const d of deps) if (!/^T\d+$/.test(d)) problems.push(`${head[1]} Deps: "${d}" is not a task id.`);
    tasks.push({ id: head[1]!, title: head[2]!.trim(), files, model, steps, deps });
  }
  return tasks;
}

function parseMutations(text: string | undefined, problems: string[]): PlannedMutation[] {
  if (text === undefined) return [];
  if (/^\s*none:\s*\S/i.test(text)) return [];
  const out: PlannedMutation[] = [];
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    try {
      const j = JSON.parse(m[1]!) as Record<string, unknown>;
      const bad = ["name", "file", "find", "replace", "test"].find((k) => typeof j[k] !== "string");
      if (bad) problems.push(`A mutation lacks "${bad}".`);
      else out.push(j as unknown as PlannedMutation);
    } catch {
      problems.push("A mutation block is not valid JSON.");
    }
  }
  if (!out.length) problems.push('Mutation must hold a json block, or "none: <reason>".');
  return out;
}

function parseCriteria(text: string | undefined, taskIds: Set<string>, problems: string[]): PlannedCriterion[] {
  const out: PlannedCriterion[] = [];
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*-\s*(AC-\d+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const at = m[2]!.search(/checked by/i);
    const commands = at < 0 ? [] : ticks(m[2]!.slice(at));
    const task = /\((T\d+)\)\s*$/.exec(m[2]!.trim())?.[1] ?? "";
    if (!commands.length) problems.push(`${m[1]} names no test or command: end it with "checked by \`<cmd>\` (T<n>)".`);
    if (!task || !taskIds.has(task))
      problems.push(`${m[1]} maps to ${task || "no task"}, which is not a task in Change.`);
    out.push({
      id: m[1]!,
      text: m[2]!
        .slice(0, at < 0 ? undefined : at)
        .replace(/:\s*$/, "")
        .trim(),
      commands,
      task,
    });
  }
  if (!out.length) problems.push("Acceptance lists no `- AC-n:` line.");
  return out;
}

export function parsePlannedIssue(body: string): { plan?: PlannedIssue; problems: string[] } {
  const problems: string[] = [];
  if (!isPlannedBody(body)) return { problems: [`The body does not start with ${PLANNED_MARKER}.`] };
  const s = sections(body);
  for (const k of ["why", "change", "tests", "mutation", "acceptance", "files", "risk"])
    if (!s.has(k)) problems.push(`The body has no "## ${k[0]!.toUpperCase()}${k.slice(1)}" section.`);
  const tasks = parseTasks(s.get("change") ?? "", problems);
  if (s.has("change") && !tasks.length) problems.push("Change holds no `### T<n>:` task.");
  const graph = topoOrder(tasks.map((t) => ({ id: t.id, deps: t.deps })));
  for (const m of graph.missing) problems.push(`${m.id} depends on ${m.dep}, which is not a task in Change.`);
  for (const c of graph.cycles) problems.push(`Tasks ${c.join(" -> ")} form a cycle.`);
  const meta = parseMeta(body);
  problems.push(...meta.problems);
  const criteria = parseCriteria(s.get("acceptance"), new Set(tasks.map((t) => t.id)), problems);
  const files = (s.get("files") ?? "").split("\n").flatMap((l) => {
    const m = /^\s*-\s*`([^`]+)`(\s*\(new\))?/.exec(l);
    return m ? [{ path: m[1]!, isNew: !!m[2] }] : [];
  });
  const listed = new Set(files.map((f) => f.path));
  for (const t of tasks)
    for (const f of t.files)
      if (!listed.has(f)) problems.push(`${t.id} touches \`${f}\`, which "## Files" does not list.`);
  const risk = /^## Risk:\s*(\w+)/im.exec(body)?.[1]?.toLowerCase();
  if (risk !== "low" && risk !== "medium" && risk !== "high") problems.push('"## Risk:" must be low, medium or high.');
  const mutations = parseMutations(s.get("mutation"), problems);
  if (problems.length) return { problems };
  return {
    problems,
    plan: {
      goal: (s.get("why") ?? "").trim().split("\n")[0]!,
      tasks,
      tests: bullets(s.get("tests")),
      mutations,
      criteria,
      nonGoals: bullets(s.get("non-goals")),
      files,
      risk: risk as Risk,
      model: /^## Model:\s*(\w+)/im.exec(body)?.[1]?.toLowerCase() ?? "sonnet",
      meta,
    },
  };
}

// The artifact and comment the plan stage writes, so build and verify cannot tell the two apart.
export function planFromIssue(p: PlannedIssue, issue: { body: string }, revision = 1) {
  const ng = p.nonGoals.map((n, i) => `- **NG-${i + 1}:** ${n.replace(/^NG-\d+:\s*/, "")}`);
  const comment = [
    `<!-- factory:plan v1 rev=${revision} -->`,
    `## Plan (rev ${revision})`,
    "",
    `**Goal:** ${p.goal}`,
    "",
    "### Acceptance criteria",
    ...p.criteria.map((c) => `- **${c.id}:** ${c.text}: checked by ${c.commands.map((x) => `\`${x}\``).join(", ")}`),
    "",
    "### Non-goals (binding; a diff that crosses one fails verify)",
    ...(ng.length ? ng : ["- **NG-1:** none beyond the issue's own scope."]),
    "",
    "### Files to touch",
    ...p.files.map((f) => `- \`${f.path}\`${f.isNew ? " (new)" : ""}`),
    "",
    "### Tests to write first",
    ...p.tests.map((t) => (t.includes("`") ? `- ${t}` : `- \`${t}\``)),
    "",
    "### Repo skills to apply",
    "none",
    "",
    `### Risk: ${p.risk}`,
    "Planned in the issue.",
    "",
    "**Gate level:** per the issue's Tests section.",
    "",
  ].join("\n");
  // Dependencies first, so build reads a task's prerequisites before the task itself.
  const ordered = topoOrder(p.tasks.map((t) => ({ id: t.id, deps: t.deps }))).order;
  const plan = {
    risk: p.risk,
    revision,
    files: p.files.map((f) => f.path),
    autoApproveEligible: false,
    proof: "test" as const,
    goal: p.goal,
    criteria: p.criteria.map((c) => ({ id: c.id, text: c.text, task: c.task })),
    tasks: ordered.map((id) => p.tasks.find((t) => t.id === id)!),
    mutations: p.mutations,
    bodyHash: sha256(issue.body),
    source: "issue" as const,
    model: p.model,
  };
  return { plan, comment };
}
