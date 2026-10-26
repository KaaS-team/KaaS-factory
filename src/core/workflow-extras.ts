// Keys added in P5 (step agent, timeout, retries, tool, with; `emit:` chaining): taken off the raw
// mapping, checked here, then put back on what parseWorkflow returns, so the core parser stays the
// one walker of steps and edges. Pure: no I/O.

import { parseWorkflow, type Step, type StepKind, type WorkflowResult } from "./workflow";

const STEP_EXTRAS = ["agent", "timeout", "retries", "tool", "with"] as const;
const NAME = /^[\w.-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

type Extras = Partial<Pick<Step, "agent" | "timeoutMinutes" | "retries" | "tool" | "with">>;

export function parseWorkflowFull(
  raw: unknown,
  kinds: Readonly<Record<string, StepKind>>,
  exprRoots: readonly string[] = [],
): WorkflowResult {
  if (!isObj(raw)) return parseWorkflow(raw, kinds, exprRoots);
  const problems: string[] = [];
  const { emit, ...top } = raw;
  if (emit !== undefined && (typeof emit !== "string" || !NAME.test(emit)))
    problems.push("emit: a name other workflows' on.emitted can match");
  let emitted: string[] | undefined;
  if (isObj(top.on) && top.on.emitted !== undefined) {
    const { emitted: e, ...on } = top.on;
    const list = typeof e === "string" ? [e] : e;
    if (!Array.isArray(list) || list.length === 0 || !list.every((n) => typeof n === "string" && NAME.test(n)))
      problems.push("on.emitted: an emit name, or a list of them");
    else emitted = [...new Set(list as string[])];
    top.on = Object.keys(on).length ? on : undefined;
    if (top.on === undefined) delete top.on;
  }
  const extras: Record<string, Extras> = {};
  if (isObj(top.steps)) {
    const steps: Record<string, unknown> = {};
    for (const [id, s] of Object.entries(top.steps)) {
      if (!isObj(s)) {
        steps[id] = s;
        continue;
      }
      const rest = { ...s };
      for (const k of STEP_EXTRAS) delete rest[k];
      steps[id] = rest;
      extras[id] = stepExtras(`steps.${id}`, s, kinds[String(s.uses)], problems);
    }
    top.steps = steps;
  }
  const parsed = parseWorkflow(top, kinds, exprRoots);
  if (!parsed.ok) return { ok: false, problems: [...parsed.problems, ...problems] };
  if (problems.length) return { ok: false, problems };
  const w = parsed.workflow;
  const steps = Object.fromEntries(Object.entries(w.steps).map(([id, s]) => [id, { ...s, ...extras[id] }]));
  return {
    ok: true,
    workflow: {
      ...w,
      steps,
      triggers: { ...w.triggers, ...(emitted ? { emitted } : {}) },
      ...(typeof emit === "string" ? { emit } : {}),
    },
  };
}

function stepExtras(where: string, s: Record<string, unknown>, kind: StepKind | undefined, problems: string[]): Extras {
  const out: { -readonly [K in keyof Extras]: Extras[K] } = {};
  if (s.agent !== undefined) {
    if (typeof s.agent !== "string" || !NAME.test(s.agent))
      problems.push(`${where}.agent: an agent name from config.agents`);
    else if (kind && !kind.agent) problems.push(`${where}.agent: a ${s.uses} step runs no agent`);
    else out.agent = s.agent;
  }
  if (s.timeout !== undefined) {
    const m = typeof s.timeout === "string" ? /^([1-9]\d*)m$/.exec(s.timeout) : null;
    const minutes = typeof s.timeout === "number" ? s.timeout : m ? Number(m[1]) : NaN;
    if (!Number.isInteger(minutes) || minutes <= 0) problems.push(`${where}.timeout: minutes, like 30 or "30m"`);
    else out.timeoutMinutes = minutes;
  }
  if (s.retries !== undefined) {
    if (!Number.isInteger(s.retries) || (s.retries as number) < 0 || (s.retries as number) > 5)
      problems.push(`${where}.retries: a whole number from 0 to 5`);
    else if (kind && !kind.command && !kind.tool)
      problems.push(`${where}.retries: only a check or tool step retries; an agent step's retry is a reject`);
    else out.retries = s.retries as number;
  }
  if (kind?.tool && typeof s.tool !== "string") problems.push(`${where}.tool: required, the server/tool it calls`);
  if (s.tool !== undefined) {
    if (typeof s.tool !== "string" || !/^[\w-]{1,64}\/[\w.-]{1,64}$/.test(s.tool))
      problems.push(`${where}.tool: "server/tool", a server from .factory/mcp.json and one of its tools`);
    else if (kind && !kind.tool) problems.push(`${where}.tool: a ${s.uses} step calls no tool`);
    else out.tool = s.tool;
  }
  if (s.with !== undefined) {
    if (!isObj(s.with)) problems.push(`${where}.with: a mapping, the tool's arguments`);
    else if (kind && !kind.tool) problems.push(`${where}.with: only a tool step takes arguments`);
    else out.with = s.with;
  }
  return out;
}
