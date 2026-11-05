// The generic tracker: TrackerPort driven by a mapping file (./mapping.ts) over a transport that
// calls one tool and returns its JSON answer. MCP is the transport here; a declared CLI tool is the
// other (./mapped-cli.ts). No tracker-specific code: a new tracker is a new mapping file.

import type { GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import { callMcpTool } from "../../mcp-call";
import { atPath, type CallName, fillTemplate, type MappedCall, type TrackerMapping, type Vars } from "./mapping";

// Runs a mapped call with its template variables and returns the tool's parsed JSON answer.
export interface CallTransport {
  call(call: MappedCall, vars: Vars): Promise<unknown>;
}

export class MappedTrackerError extends Error {}

export function parseAnswer(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new MappedTrackerError(`${what} answered text that is not JSON: ${text.slice(0, 120)}`);
  }
}

// An MCP server named in the repo's .factory/mcp.json, called over stdio like a workflow `tool` step.
export class McpTransport implements CallTransport {
  constructor(
    private readonly dir: string,
    private readonly server: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly declared: readonly string[] = [],
  ) {}

  async call(call: MappedCall, vars: Vars): Promise<unknown> {
    const spec = `${this.server}/${call.tool}`;
    const args = fillTemplate(call.args ?? {}, vars) as Record<string, unknown>;
    const r = await callMcpTool(this.dir, spec, args, 60_000, this.declared, this.env);
    if (!r.ok) throw new MappedTrackerError(`${spec} returned an error: ${r.text.slice(0, 200)}`);
    return parseAnswer(r.text, spec);
  }
}

const closed = (state: unknown, m: TrackerMapping) =>
  String(state ?? "").toLowerCase() === m.states.closed.toLowerCase();

export class MappedTracker implements TrackerPort {
  constructor(
    private readonly mapping: TrackerMapping,
    private readonly transport: CallTransport,
    private readonly project: string,
  ) {}

  private async run(name: CallName, vars: Vars): Promise<unknown> {
    const call = this.mapping.calls[name];
    if (!call) throw new MappedTrackerError(`the mapping has no "${name}" call`);
    const answer = await this.transport.call(call, { repo: this.project, project: this.project, ...vars });
    return atPath(answer, call.items);
  }

  private issue(raw: unknown): GhIssue {
    const f = this.mapping.fields;
    const num = atPath(raw, f.number);
    const n = typeof num === "number" ? num : Number(/(\d+)$/.exec(String(num ?? ""))?.[1]);
    if (!Number.isInteger(n))
      throw new MappedTrackerError(`fields.number "${f.number}" gave ${JSON.stringify(num)}, not a number`);
    const labels = atPath(raw, f.labels);
    const state = atPath(raw, f.state);
    return {
      number: n,
      title: String(atPath(raw, f.title) ?? ""),
      body: String(atPath(raw, f.body) ?? ""),
      labels: (Array.isArray(labels) ? labels : []).map((l) => ({
        name: String(typeof l === "object" && l !== null ? ((l as { name?: unknown }).name ?? "") : l),
      })),
      comments: [],
      state: closed(state, this.mapping) ? "CLOSED" : "OPEN",
    };
  }

  private async issues(label: string): Promise<GhIssue[]> {
    const answer = await this.run("list", { label });
    if (!Array.isArray(answer))
      throw new MappedTrackerError('the "list" call did not answer an array (set its "items" path)');
    return answer.map((x) => this.issue(x)).filter((i) => i.state !== "CLOSED");
  }

  listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return this.issues(label).then((all) => all.filter((i) => i.labels.some((l) => l.name === label)));
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.issues("");
  }
  async getIssue(_repo: string, number: number): Promise<GhIssue> {
    return this.issue(await this.run("read", { number }));
  }

  // One update call carries the whole new state, so a mapping has one write to describe.
  private async update(
    number: number,
    change: (i: GhIssue) => Partial<{ labels: string[]; state: string; body: string }>,
  ) {
    const cur = await this.getIssue("", number);
    const next = {
      labels: cur.labels.map((l) => l.name),
      state: cur.state === "CLOSED" ? this.mapping.states.closed : this.mapping.states.open,
      body: cur.body,
      ...change(cur),
    };
    await this.run("update", { number, ...next });
  }

  addLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    return this.update(number, (i) => ({ labels: [...new Set([...i.labels.map((l) => l.name), ...labels])] }));
  }
  removeLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    return this.update(number, (i) => ({ labels: i.labels.map((l) => l.name).filter((l) => !labels.includes(l)) }));
  }
  setStateLabel(_repo: string, number: number, current: string[], next: string): Promise<void> {
    return this.update(number, (i) => ({
      labels: [...i.labels.map((l) => l.name).filter((l) => !current.includes(l)), next],
    }));
  }
  closeIssue(_repo: string, number: number): Promise<void> {
    return this.update(number, () => ({ state: this.mapping.states.closed }));
  }
  reopenIssue(_repo: string, number: number): Promise<void> {
    return this.update(number, () => ({ state: this.mapping.states.open }));
  }
  editIssueBody(_repo: string, number: number, body: string): Promise<void> {
    return this.update(number, () => ({ body }));
  }

  async commentIssue(_repo: string, number: number, body: string): Promise<number | undefined> {
    await this.run("comment", { number, comment: body });
    return undefined;
  }
  async editComment(): Promise<void> {
    throw new MappedTrackerError("a mapped tracker cannot edit a comment");
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    return this.issue(await this.run("create", { title, body, labels })).number;
  }
  async listLabels(): Promise<string[]> {
    return [];
  }
  async ensureLabel(): Promise<void> {}
  async currentLogin(): Promise<string> {
    return this.mapping.login;
  }
  async labeledBy(): Promise<string | undefined> {
    return undefined;
  }
  async roleOf(): Promise<RepoRole> {
    return "none";
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.issues("");
      return { ok: true, detail: 'the mapped "list" call answered' };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

export interface ProbeRow {
  readonly call: "list" | "read" | "update";
  readonly status: "ok" | "failed" | "skipped";
  readonly detail: string;
}

// Which mapped calls work. list and read only read. update changes the tracker, so it runs only with
// `write`, and then re-sends the first issue's own values: a no-op in content.
export async function probeMapped(t: MappedTracker, write = false): Promise<ProbeRow[]> {
  const rows: ProbeRow[] = [];
  let first: GhIssue | undefined;
  try {
    const open = await t.listOpenIssues();
    first = open[0];
    rows.push({ call: "list", status: "ok", detail: `${open.length} open issue(s)` });
  } catch (e) {
    rows.push({ call: "list", status: "failed", detail: (e as Error).message });
  }
  if (!first) rows.push({ call: "read", status: "skipped", detail: "no issue to read" });
  else
    try {
      const got = await t.getIssue("", first.number);
      rows.push({ call: "read", status: "ok", detail: `#${got.number} ${got.title}` });
    } catch (e) {
      rows.push({ call: "read", status: "failed", detail: (e as Error).message });
    }
  if (!write)
    rows.push({ call: "update", status: "skipped", detail: "it writes; pass --write to try it on the first issue" });
  else if (!first) rows.push({ call: "update", status: "skipped", detail: "no issue to update" });
  else
    try {
      await t.addLabels("", first.number, []);
      rows.push({ call: "update", status: "ok", detail: `#${first.number} sent unchanged` });
    } catch (e) {
      rows.push({ call: "update", status: "failed", detail: (e as Error).message });
    }
  return rows;
}
