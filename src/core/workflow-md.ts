// `.factory/workflows/<name>.md`: YAML frontmatter with `stages:` (needs, agent, tools, gates,
// approval) over a markdown body, turned into the same raw `steps:` mapping a .yml file has, so
// one parser checks both and every existing .yml keeps working. Pure: no I/O.

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const STAGE_KEYS = new Set([
  "uses",
  "label",
  "needs",
  "agent",
  "tools",
  "gates",
  "approval",
  "retries",
  "timeout",
  "run",
  "runtime",
  "reject",
  "revise",
  "tool",
  "with",
  "env",
]);
const TOP_KEYS = new Set(["name", "description", "on", "limits", "emit", "stages"]);
const PASS = ["agent", "retries", "timeout", "run", "runtime", "reject", "revise", "tool", "with", "env"] as const;
const RISKS = ["low", "medium", "high"] as const;
// The labels the factory has always used for its five stages; any other stage gets factory:<id>.
const LABELS: Record<string, string> = {
  triage: "factory:triaging",
  plan: "factory:planning",
  build: "factory:building",
  verify: "factory:verifying",
  pr: "factory:in-review",
};

export type MdResult = { ok: true; raw: Record<string, unknown>; body: string } | { ok: false; problems: string[] };

export function isWorkflowMd(text: string): boolean {
  return /^---\r?\n/.test(text);
}

export function workflowMdToRaw(text: string, parseYaml: (s: string) => unknown): MdResult {
  const end = text.indexOf("\n---", 3);
  if (!isWorkflowMd(text) || end < 0) return { ok: false, problems: ["frontmatter: needs --- lines around it"] };
  let front: unknown;
  try {
    front = parseYaml(text.slice(text.indexOf("\n") + 1, end));
  } catch (e) {
    return { ok: false, problems: [`frontmatter: not valid YAML: ${(e as Error).message}`] };
  }
  const body = text.slice(text.indexOf("\n", end + 1) + 1).trim();
  if (!isObj(front)) return { ok: false, problems: ["frontmatter: a mapping with name and stages"] };
  const problems: string[] = [];
  for (const k of Object.keys(front))
    if (!TOP_KEYS.has(k)) problems.push(`${k}: unknown key (allowed: ${[...TOP_KEYS].join(", ")})`);
  if (!isObj(front.stages) || Object.keys(front.stages).length === 0)
    return { ok: false, problems: [...problems, "stages: needs at least one stage"] };
  const stages = front.stages;
  const order = topoOrder(stages, problems);
  const steps: Record<string, Record<string, unknown>> = {};
  const builds = order.filter((id) => (isObj(stages[id]) ? (stages[id].uses ?? id) : id) === "build");
  order.forEach((id, i) => {
    const s = stages[id];
    const where = `stages.${id}`;
    if (!isObj(s)) return void problems.push(`${where}: must be a mapping`);
    for (const k of Object.keys(s))
      if (!STAGE_KEYS.has(k)) problems.push(`${where}.${k}: unknown key (allowed: ${[...STAGE_KEYS].join(", ")})`);
    const uses = typeof s.uses === "string" ? s.uses : id;
    const step: Record<string, unknown> = {
      uses,
      label: typeof s.label === "string" ? s.label : (LABELS[id] ?? `factory:${id}`),
    };
    for (const k of PASS) if (s[k] !== undefined) step[k] = s[k];
    if (s.tools !== undefined) step.mcp = s.tools;
    if (uses === "verify" && step.reject === undefined && builds[0]) step.reject = builds[0];
    if (uses === "pr" && step.revise === undefined && builds[0]) step.revise = builds[0];
    steps[id] = step;
    let last = id;
    if (s.gates !== undefined) {
      const names = Array.isArray(s.gates) ? s.gates : [];
      if (!names.length || !names.every((g) => typeof g === "string" && /^[\w.-]+$/.test(g)))
        problems.push(`${where}.gates: a list of gate names from .factory/config.json`);
      last = `${id}-gates`;
      steps[last] = {
        uses: "check",
        label: `factory:${last}`,
        run: `FACTORY_GATES_ONLY=${names.join(",")} bash .factory/gates.sh`,
      };
      step.next = last;
    }
    const after = order[i + 1];
    if (after === undefined) return;
    const approval = s.approval ?? "none";
    if (approval === "none") steps[last]!.next = after;
    else if (approval === "always") steps[last]!.next = [{ park: "awaiting-approval", approve: after, revise: id }];
    else {
      const level = typeof approval === "string" ? /^on-risk:(low|medium|high)$/.exec(approval)?.[1] : undefined;
      if (!level) return void problems.push(`${where}.approval: none, always, or on-risk:<low|medium|high>`);
      const risky = RISKS.slice(RISKS.indexOf(level as (typeof RISKS)[number]));
      steps[last]!.next = [
        {
          if: risky.map((r) => `${id}.risk == '${r}'`).join(" || "),
          park: "awaiting-approval",
          approve: after,
          revise: id,
        },
        { to: after },
      ];
    }
  });
  if (problems.length) return { ok: false, problems };
  const { stages: _drop, ...rest } = front;
  return {
    ok: true,
    raw: { ...rest, ...(rest.description === undefined && body ? { description: body } : {}), steps },
    body,
  };
}

// Declaration order, moved only as far as `needs:` makes it: the factory walks one stage at a time.
function topoOrder(stages: Record<string, unknown>, problems: string[]): string[] {
  const ids = Object.keys(stages);
  const needs = (id: string): string[] => {
    const n = isObj(stages[id]) ? stages[id].needs : undefined;
    const list = n === undefined ? [] : typeof n === "string" ? [n] : n;
    if (!Array.isArray(list)) return [];
    for (const d of list) if (!ids.includes(d)) problems.push(`stages.${id}.needs: no stage "${d}"`);
    return list.filter((d) => ids.includes(d));
  };
  const out: string[] = [];
  const open = new Set<string>();
  const visit = (id: string): void => {
    if (out.includes(id)) return;
    if (open.has(id)) return void problems.push(`stages.${id}.needs: a cycle through ${id}`);
    open.add(id);
    for (const d of needs(id)) visit(d);
    open.delete(id);
    out.push(id);
  };
  for (const id of ids) visit(id);
  return out;
}
