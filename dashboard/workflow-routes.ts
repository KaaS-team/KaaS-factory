// The Events, Minions and workflow-editor routes. Events and minions carry spend and agent names,
// so they are operator pages; an edit to a workflow never touches the repo, it opens a PR
// (src/workflow-edit.ts), and the Workflows page stays read-only.

import { EventBus } from "../src/engine/bus";
import { loadMinions } from "../src/engine/minion";
import { Git, GitCommandRunner } from "../src/git";
import type { ScmPort } from "../src/github";
import type { FactoryState } from "../src/state";
import { proposeWorkflowEdit, type WorkflowForm, workflowSource } from "../src/workflow-edit";
import { plain } from "../src/display";
import { harnessReport } from "../src/harness";
import type { Actor, Route } from "./plane/access";
import { senderName } from "./plane/commands";
import { NO_PROJECT, type DashboardProject, workflowsView } from "./project";

export interface WorkflowRouteDeps {
  readonly state: FactoryState;
  readonly github: ScmPort;
  readonly workspacesDir: string;
  readonly project?: DashboardProject;
  readonly actorOf: (req: Request) => Actor | undefined;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const MAX_EVENTS = 500;

// Event data and workflow files come from outside, so every string is plain()-ed before it is shown.
const clean = (v: unknown): unknown =>
  typeof v === "string"
    ? plain(v)
    : Array.isArray(v)
      ? v.map(clean)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [plain(k), clean(x)]))
        : v;
const parse = (data: string): unknown => {
  try {
    return clean(JSON.parse(data));
  } catch {
    return plain(data);
  }
};

export function eventsView(state: Pick<FactoryState, "busEvents" | "busDeliveries">, limit: number, after: number) {
  return state.busEvents(Math.min(Math.max(1, limit), MAX_EVENTS), after).map((r) => ({
    seq: r.seq ?? 0,
    id: r.id,
    direction: r.direction,
    type: plain(r.type),
    subject: r.subject === null ? null : plain(r.subject),
    time: r.time,
    data: parse(r.data),
    deliveries: state.busDeliveries(r.id).map((d) => ({ sink: d.sink, status: d.status, attempts: d.attempts })),
  }));
}

// Each minion with its trigger and the newest completed run the outbox remembers.
export function minionsView(state: Pick<FactoryState, "busEvents">, project: DashboardProject) {
  const loaded = loadMinions(project.cloneDir, project.config);
  const last = new Map<string, { time: string; ok: boolean; reason?: string; costUsd?: number | null }>();
  for (const r of state.busEvents(MAX_EVENTS)) {
    if (r.type !== "factory.minion.completed") continue;
    const d = parse(r.data) as { minion?: string; ok?: boolean; reason?: string; costUsd?: number | null };
    if (d.minion) last.set(d.minion, { time: r.time, ok: Boolean(d.ok), reason: d.reason, costUsd: d.costUsd });
  }
  return {
    problems: loaded.problems,
    minions: loaded.minions.map((m) => ({
      name: m.name,
      description: m.description,
      on: "event" in m.on ? { event: m.on.event } : { cron: true, tz: m.on.tz },
      agent: m.agent ?? null,
      emit: m.emit ?? null,
      checkout: m.checkout === true,
      lastRun: last.get(m.name) ?? null,
    })),
  };
}

export function workflowRoutes(deps: WorkflowRouteDeps): Route[] {
  const project = deps.project;
  return [
    {
      method: "GET",
      pattern: /^\/api\/workflows$/,
      label: "GET /api/workflows",
      role: "viewer",
      handler: async () =>
        project
          ? json({ available: true, ...workflowsView(await harnessReport(project.cloneDir, project.config)) })
          : json({ available: false, reason: NO_PROJECT }),
    },
    {
      method: "GET",
      pattern: /^\/api\/events$/,
      label: "GET /api/events",
      role: "operator",
      handler: (_req, url) =>
        json({
          events: eventsView(
            deps.state,
            Number(url.searchParams.get("limit") ?? 100),
            Number(url.searchParams.get("after") ?? 0),
          ),
        }),
    },
    {
      method: "POST",
      pattern: /^\/api\/events\/([\w.:-]+)\/replay$/,
      label: "POST /api/events/:event/replay",
      role: "operator",
      handler: async (_req, _url, m) => {
        if (!project) return json({ error: NO_PROJECT }, 409);
        const bus = new EventBus({
          store: deps.state,
          sinks: project.config.events.sinks,
          source: `factory/${project.config.repo}`,
          autoDeliver: false,
          log: () => {},
        });
        const queued = bus.replay(m[1]!);
        if (!queued) return json({ error: `no event "${m[1]}" with a configured sink` }, 404);
        return json({ ok: true, queued, delivered: await bus.deliver() });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/minions$/,
      label: "GET /api/minions",
      role: "operator",
      handler: () =>
        project
          ? json({ available: true, ...minionsView(deps.state, project) })
          : json({ available: false, reason: NO_PROJECT }),
    },
    {
      method: "GET",
      pattern: /^\/api\/workflow-source$/,
      label: "GET /api/workflow-source",
      role: "viewer",
      handler: (_req, url) => {
        const src = project ? workflowSource(project.cloneDir, url.searchParams.get("name") ?? "") : undefined;
        return json(
          src ? { available: true, ...src, text: plain(src.text) } : { available: false, reason: "no such workflow" },
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/workflow-edit$/,
      label: "POST /api/workflow-edit",
      role: "operator",
      handler: async (req) => {
        if (!project) return json({ error: NO_PROJECT }, 409);
        const body = (await req.json().catch(() => ({}))) as { name?: unknown; form?: WorkflowForm };
        if (typeof body.name !== "string") return json({ error: "name the workflow" }, 400);
        if (!body.form || typeof body.form !== "object")
          return json({ error: "a form of step fields is required" }, 400);
        const git = project.git ?? new Git(new GitCommandRunner());
        const out = await proposeWorkflowEdit(
          { github: deps.github, git, cloneDir: project.cloneDir, workspacesDir: deps.workspacesDir },
          {
            repo: project.config.repo,
            base: project.config.base,
            name: body.name,
            form: body.form,
            by: senderName(deps.actorOf(req)),
          },
        );
        return "problems" in out ? json({ error: out.problems.join("; "), problems: out.problems }, 422) : json(out);
      },
    },
  ];
}
