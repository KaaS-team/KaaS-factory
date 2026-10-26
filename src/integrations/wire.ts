// The watcher's side of every outside surface: one bus subscriber that turns each factory event into
// a progress note and hands it to the integrations whose env keys are set. A surface that is down
// costs a log line, never a run: the bus logs a failing subscriber and goes on.

import type { CloudEvent } from "../core/event";
import type { StageRun } from "../state";
import { CHECKS_ENV, CheckProgress } from "./checks";
import { activityOf, LINEAR_AGENT_ENV, LinearAgentClient, type PlanItem, SURFACE as LINEAR } from "./linear-agent";
import type { FactoryConfig } from "../config";
import { EventBus } from "../engine/bus";
import type { FactoryState } from "../state";
import { LinkStore } from "./links";
import { bearer, MCP_ENV, McpClient, notifyMcp, recordMcpEvents } from "./mcp-client";
import { exportTrace, OTEL_ENV, runTrace } from "./otel";
import { progressOf } from "./progress";
import { SURFACE as SLACK, SLACK_ENV, SlackClient, slackProgress } from "./slack";

export interface WireDeps {
  readonly subscribe: (type: string, fn: (e: CloudEvent) => Promise<void>) => unknown;
  readonly links: Pick<LinkStore, "byIssue">;
  readonly stageRuns: (repo: string, issue: number) => StageRun[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

// The names of the integrations it turned on, for the watcher's boot line.
export function wireIntegrations(deps: WireDeps): string[] {
  const env = deps.env ?? process.env;
  const on: ((e: CloudEvent) => Promise<void>)[] = [];
  const names: string[] = [];
  const use = (name: string, keys: readonly string[], fn: (e: CloudEvent) => Promise<void>) => {
    if (!keys.every((k) => env[k])) return;
    on.push(fn);
    names.push(name);
  };

  const linear = new LinearAgentClient(env.LINEAR_AGENT_URL, env);
  const plans = new Map<string, PlanItem[]>();
  use("linear-agent", [LINEAR_AGENT_ENV.token], async (e) => {
    const p = progressOf(e);
    if (!p) return;
    for (const { external } of deps.links.byIssue(LINEAR, p.repo, p.issue)) {
      // The session's plan is the steps seen so far, each marked as it starts and ends.
      const plan = plans.get(external) ?? [];
      if (p.step && (p.kind === "action" || p.kind === "thought")) {
        const rest = plan.filter((s) => s.content !== p.step);
        plans.set(external, [...rest, { content: p.step, status: p.kind === "action" ? "inProgress" : "completed" }]);
        await linear.update(external, { plan: plans.get(external)! });
      }
      if (p.url) await linear.update(external, { externalUrls: [{ label: "Pull request", url: p.url }] });
      const content = activityOf(p);
      if (content) await linear.activity(external, content);
    }
  });

  const slack = new SlackClient(env.SLACK_API_URL, env);
  use("slack", [SLACK_ENV.token], async (e) => {
    const p = progressOf(e);
    if (p)
      for (const { external } of deps.links.byIssue(SLACK, p.repo, p.issue)) await slackProgress(slack, external, p);
  });

  const mcp = new McpClient(env[MCP_ENV.notifyUrl] ?? "", bearer(env[MCP_ENV.token]));
  use("mcp-notifier", [MCP_ENV.notifyUrl, MCP_ENV.notifyTool], async (e) => {
    const p = progressOf(e);
    if (p) await notifyMcp(mcp, env[MCP_ENV.notifyTool]!, p);
  });

  const checks = new CheckProgress(env.GITHUB_API_URL, env);
  use("github-checks", [CHECKS_ENV.token], (e) => checks.on(e));

  // A run's stages are those that started after its first step event, so a retry is its own trace.
  const since = new Map<string, string>();
  use("otel", [OTEL_ENV.endpoint], async (e) => {
    const p = progressOf(e);
    if (!p) return;
    const key = `${p.repo}#${p.issue}`;
    if (!since.has(key)) since.set(key, e.time);
    if (e.type !== "factory.run.completed") return;
    const from = since.get(key)!;
    since.delete(key);
    const stages = deps.stageRuns(p.repo, p.issue).filter((s) => s.started_at >= from);
    const outcome = String((e.data as { outcome?: unknown }).outcome ?? "");
    const trace = runTrace({ repo: p.repo, issue: p.issue, outcome }, stages);
    if (trace) await exportTrace(env[OTEL_ENV.endpoint]!, env[OTEL_ENV.headers], trace);
  });

  for (const fn of on) deps.subscribe("*", fn);
  return names;
}

// The watcher's bus, with every integration whose keys are set listening on it. The link store opens
// only when a surface that needs it is on, so a plain run never creates the file.
export function withIntegrations(
  bus: EventBus,
  state: { listStageRuns: (repo: string, o: { issue: number }) => StageRun[] },
) {
  let links: LinkStore | undefined;
  const names = wireIntegrations({
    subscribe: (type, fn) => bus.subscribe(type, fn),
    links: { byIssue: (s, repo, issue) => (links ??= new LinkStore()).byIssue(s, repo, issue) },
    stageRuns: (repo, issue) => state.listStageRuns(repo, { issue }),
  });
  if (names.length) console.error(`integrations on: ${names.join(", ")}`);
  return bus;
}

// The MCP event source: the watcher asks the tool every minute; a failed ask is a log line.
export function pollMcpEvents(state: Pick<FactoryState, "recordBusEvent">, env = process.env, everyMs = 60_000) {
  const url = env[MCP_ENV.eventsUrl];
  const tool = env[MCP_ENV.eventsTool];
  if (!url || !tool) return undefined;
  const client = new McpClient(url, bearer(env[MCP_ENV.token]));
  const tick = () => recordMcpEvents(client, tool, state).catch((e) => console.error(`mcp events: ${String(e)}`));
  setInterval(tick, everyMs).unref();
  return tick;
}

// The watcher's bus: the outbox and sinks config names, plus the integrations.
export function watcherBus(state: FactoryState, config: Pick<FactoryConfig, "events" | "repo">) {
  pollMcpEvents(state);
  return withIntegrations(
    new EventBus({ store: state, sinks: config.events.sinks, source: `factory/${config.repo}` }),
    state,
  );
}
