// The planning steps over the tracker port: spec turns a goal into issues, decompose splits an epic
// into linked children, prioritize ranks the backlog. All three read and write only through TrackerPort.

import type { GhIssue } from "../github";
import { LABEL } from "../labels";
import type { TrackerPort } from "../ports/scm";
import { rankIssues, scoreOf } from "../prioritize";
import { checklist } from "./epic";
import { finish, moveLabel, postComment } from "./common";
import type { StepResult, StepType } from "./steps";

export interface SpecDraft {
  readonly title: string;
  readonly problem: string;
  readonly acceptance: readonly string[];
  readonly outOfScope: readonly string[];
}

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join("\n");

export function renderSpec(d: SpecDraft): string {
  const out = d.outOfScope.length ? bullets(d.outOfScope) : "- Nothing else.";
  return `## Problem\n\n${d.problem}\n\n## Acceptance\n\n${bullets(d.acceptance)}\n\n## Out of scope\n\n${out}\n`;
}

// Drafts live in a fenced ```spec block of JSON in the goal issue, so a person or an agent step can write them.
export function parseDrafts(body: string): { drafts: SpecDraft[] } | { problem: string } {
  const m = /```spec\s*\n([\s\S]*?)```/.exec(body);
  if (!m) return { problem: "the goal has no ```spec block of drafts" };
  let raw: unknown;
  try {
    raw = JSON.parse(m[1]!);
  } catch {
    return { problem: "the ```spec block is not valid JSON" };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { problem: "the ```spec block must be a non-empty list" };
  const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim());
  const drafts: SpecDraft[] = [];
  for (const [i, d] of raw.entries()) {
    const r = (d ?? {}) as Record<string, unknown>;
    if (typeof r.title !== "string" || !r.title.trim()) return { problem: `draft ${i + 1}: title is required` };
    if (typeof r.problem !== "string" || !r.problem.trim()) return { problem: `draft ${i + 1}: problem is required` };
    if (!strs(r.acceptance) || r.acceptance.length === 0)
      return { problem: `draft ${i + 1}: acceptance needs at least one line` };
    const outOfScope = r.outOfScope === undefined ? [] : r.outOfScope;
    if (!strs(outOfScope)) return { problem: `draft ${i + 1}: outOfScope must be a list of lines` };
    drafts.push({ title: r.title.trim(), problem: r.problem.trim(), acceptance: r.acceptance, outOfScope });
  }
  return { drafts };
}

type Filer = Pick<TrackerPort, "createIssue">;

export async function fileSpecs(
  tracker: Filer,
  repo: string,
  drafts: readonly SpecDraft[],
  labels: string[] = [],
): Promise<number[]> {
  const made: number[] = [];
  for (const d of drafts) made.push(await tracker.createIssue(repo, d.title, renderSpec(d), labels));
  return made;
}

// Each checklist line with no #ref becomes a child issue, linked as a sub-issue and written back into the epic.
export async function decomposeEpic(
  tracker: Filer & Pick<TrackerPort, "editIssueBody" | "linkSubIssue">,
  repo: string,
  epic: Pick<GhIssue, "number" | "body">,
): Promise<{ children: number[]; body: string }> {
  if (!tracker.linkSubIssue) throw new Error("this tracker cannot link sub-issues");
  if (!tracker.editIssueBody) throw new Error("this tracker cannot edit an epic's body");
  const children: number[] = [];
  let body = epic.body;
  for (const item of checklist(epic.body)) {
    if (item.done || item.issues.length) continue;
    const draft: SpecDraft = {
      title: item.text,
      problem: `Part of #${epic.number}: ${item.text}`,
      acceptance: [`${item.text} is done and tested.`],
      outOfScope: [`Anything the other items of #${epic.number} cover.`],
    };
    const [n] = await fileSpecs(tracker, repo, [draft]);
    await tracker.linkSubIssue(repo, epic.number, n!);
    body = body.replace(`- [ ] ${item.text}`, `- [ ] #${n} ${item.text}`);

    children.push(n!);
  }
  if (children.length) await tracker.editIssueBody(repo, epic.number, body);
  return { children, body };
}

const failed = async (sc: Parameters<StepType["run"]>[0], why: string): Promise<StepResult> => {
  const { deps, config, issue, step } = sc;
  await postComment(deps, config, issue.number, `Step \`${step.id}\` failed: ${why}.`, {
    stage: step.id,
    json: { ok: false },
  });
  await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
  finish(deps, config, issue.number, "failed", `${step.id}: ${why}`);
  return { kind: "stop", outcome: "failed" };
};

const created = (made: readonly number[]) => ({ kind: "next", facts: { created: made } }) as const;

export const specStep: StepType = {
  async run(sc) {
    const parsed = parseDrafts(sc.issue.body);
    if ("problem" in parsed) return failed(sc, parsed.problem);
    const made = await fileSpecs(sc.deps.github, sc.config.repo, parsed.drafts);
    await postComment(sc.deps, sc.config, sc.issue.number, `Filed ${made.map((n) => `#${n}`).join(", ")}.`, {
      stage: sc.step.id,
      json: { created: made },
    });
    return created(made);
  },
};

export const decomposeStep: StepType = {
  async run(sc) {
    try {
      const { children } = await decomposeEpic(sc.deps.github, sc.config.repo, sc.issue);
      if (children.length)
        await postComment(
          sc.deps,
          sc.config,
          sc.issue.number,
          `Split into ${children.map((n) => `#${n}`).join(", ")}.`,
          {
            stage: sc.step.id,
            json: { created: children },
          },
        );
      return created(children);
    } catch (e) {
      return failed(sc, (e as Error).message);
    }
  },
};

export const prioritizeStep: StepType = {
  async run(sc) {
    const method = sc.config.prioritize?.method;
    if (!method) return failed(sc, "no prioritize.method is configured (rice or wsjf)");
    const ready = await sc.deps.github.listIssuesByLabel(sc.config.repo, LABEL.ready);
    const ranked = rankIssues(ready.some((i) => i.number === sc.issue.number) ? ready : [...ready, sc.issue], method);
    const rank = ranked.findIndex((i) => i.number === sc.issue.number) + 1;
    const score = scoreOf(sc.issue.body, method) ?? null;
    await postComment(
      sc.deps,
      sc.config,
      sc.issue.number,
      `Ranked ${rank} of ${ranked.length} by ${method.toUpperCase()}${score === null ? " (unscored)" : `, score ${score}`}.`,
      { stage: sc.step.id, json: { rank, score, method } },
    );
    return { kind: "next", facts: { rank, score, method } };
  },
};

export const PLANNING_STEPS: Readonly<Record<string, StepType>> = {
  spec: specStep,
  decompose: decomposeStep,
  prioritize: prioritizeStep,
};
