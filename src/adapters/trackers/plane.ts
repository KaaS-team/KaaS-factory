// TrackerPort over Plane's v2 REST API (cloud or self-hosted), for one project. Issue numbers are
// work item sequence ids, logins are Plane user ids, and labeledBy reads the activity log. Modeled on
// developers.plane.so; tests/trackers-plane.test.ts runs the contract against a fixture of it.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import {
  association,
  decodeBody,
  encodeBody,
  IdMap,
  memoOnce,
  type Field,
  type Seal,
  VendorClient,
  VendorHttpError,
  workspaceRole,
} from "./kit";

export interface PlaneSpec {
  readonly kind: "plane";
  readonly workspace: string;
  readonly project: string;
  readonly tokenEnv: string;
  readonly url?: string;
}

interface WorkItem {
  id: string;
  name: string;
  description_html: string | null;
  sequence_id: number;
  state_id: string;
  label_ids: string[];
  created_by_id: string;
  created_at: string;
}
interface Page<T> {
  data: T[];
  next: string | null;
}

const CLOSED_GROUPS = new Set(["completed", "cancelled"]);
// Plane's project roles: 20 admin, 15 member, 5 guest.
const ROLE_TIERS: Record<number, "admin" | "member" | "guest"> = { 20: "admin", 15: "member", 5: "guest" };

const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&amp;": "&",
};
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plane stores rich text as HTML. The runner's text goes in a <pre>, and anything a human wrote comes
// back as plain lines.
export function toHtml(text: string, seal: Seal, field: Field): string {
  return `<pre>${escapeHtml(encodeBody(text, seal, field))}</pre>`;
}
export function fromHtml(html: string, ours: boolean, seal: Seal, field: Field): string {
  const pre = /^<pre>([\s\S]*)<\/pre>$/.exec(html.trim());
  const text = pre
    ? pre[1]!
    : html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n+$/, "");
  return decodeBody(
    text.replace(/&(lt|gt|quot|#39|nbsp|amp);/g, (e) => ENTITIES[e]!),
    ours,
    seal,
    field,
  );
}

export class PlaneTracker implements TrackerPort {
  private readonly client: VendorClient;
  private readonly seal: Seal = (s) => this.client.seal(s);
  private readonly comments = new IdMap();
  // Each comment's work item, since Plane's comment routes sit under the item.
  private readonly commentItem = new Map<string, string>();
  private readonly bySequence = new Map<number, string>();
  private statesCache?: Promise<{ id: string; group: string }[]>;

  constructor(
    private readonly spec: PlaneSpec,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = new VendorClient(
      "plane",
      spec.url ?? "https://api.plane.so",
      spec.tokenEnv,
      (t) => ({ "x-api-key": t }),
      env,
    );
  }

  private get base(): string {
    return `/api/v2/workspaces/${encodeURIComponent(this.spec.workspace)}/projects/${encodeURIComponent(this.spec.project)}`;
  }

  private async all<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let page = await this.client.request<Page<T>>("GET", path, { query: { per_page: "100", ...query } });
    out.push(...page.data);
    while (page.next) {
      const next = new URL(page.next);
      page = await this.client.request<Page<T>>("GET", next.pathname, { query: Object.fromEntries(next.searchParams) });
      out.push(...page.data);
    }
    return out;
  }

  private states() {
    this.statesCache ??= this.all<{ id: string; group: string }>(`${this.base}/states/`);
    return this.statesCache;
  }

  private async stateIn(...groups: string[]): Promise<string> {
    const s = (await this.states()).find((x) => groups.includes(x.group));
    if (!s) throw new Error(`plane: project has no state in ${groups.join(" or ")}`);
    return s.id;
  }

  private async labelMap(): Promise<Map<string, string>> {
    const rows = await this.all<{ id: string; name: string }>(`${this.base}/labels/`);
    return new Map(rows.map((l) => [l.name, l.id]));
  }

  private async items(): Promise<WorkItem[]> {
    const rows = await this.all<WorkItem>(`${this.base}/work-items/`);
    for (const r of rows) this.bySequence.set(r.sequence_id, r.id);
    return rows;
  }

  private async item(n: number): Promise<WorkItem> {
    if (!this.bySequence.has(n)) await this.items();
    const id = this.bySequence.get(n);
    if (!id) throw new Error(`plane: no work item ${n}`);
    return this.client.request<WorkItem>("GET", `${this.base}/work-items/${id}/`);
  }

  private readonly me = memoOnce(() => this.currentLogin());

  private async toIssue(raw: WorkItem, labelNames: Map<string, string>): Promise<GhIssue> {
    const self = await this.me();
    const states = await this.states();
    const group = states.find((s) => s.id === raw.state_id)?.group ?? "backlog";
    const rows = await this.all<{ id: string; comment_html: string; created_at: string; actor_id: string }>(
      `${this.base}/work-items/${raw.id}/comments/`,
    );
    const comments: GhComment[] = [];
    for (const c of rows) {
      this.commentItem.set(c.id, raw.id);
      comments.push({
        id: this.comments.number(c.id),
        author: c.actor_id,
        authorAssociation: association(await this.roleOf("", c.actor_id)),
        body: fromHtml(c.comment_html, c.actor_id === self, this.seal, "comment"),
        createdAt: c.created_at,
      });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const closed = CLOSED_GROUPS.has(group);
    return {
      number: raw.sequence_id,
      title: raw.name,
      body: fromHtml(raw.description_html ?? "", raw.created_by_id === self, this.seal, "description"),
      labels: raw.label_ids.flatMap((id) => (labelNames.has(id) ? [{ name: labelNames.get(id)! }] : [])),
      comments,
      state: closed ? "CLOSED" : "OPEN",
      stateReason: closed ? (group === "cancelled" ? "NOT_PLANNED" : "COMPLETED") : null,
    };
  }

  private async names(): Promise<Map<string, string>> {
    return new Map([...(await this.labelMap())].map(([name, id]) => [id, name]));
  }

  private async open(filter: (w: WorkItem) => boolean): Promise<GhIssue[]> {
    const [items, names, states] = await Promise.all([this.items(), this.names(), this.states()]);
    const closed = new Set(states.filter((s) => CLOSED_GROUPS.has(s.group)).map((s) => s.id));
    const out: GhIssue[] = [];
    for (const w of items) if (!closed.has(w.state_id) && filter(w)) out.push(await this.toIssue(w, names));
    return out;
  }

  // Ids for these label names, creating any the project lacks.
  private async labelIds(names: string[], color = "ededed", description = ""): Promise<string[]> {
    if (names.length === 0) return [];
    const have = await this.labelMap();
    const ids: string[] = [];
    for (const name of names) {
      let id = have.get(name);
      if (!id) {
        id = (
          await this.client.request<{ id: string }>("POST", `${this.base}/labels/`, {
            body: { name, color: `#${color}`, description },
          })
        ).id;
        have.set(name, id);
      }
      ids.push(id);
    }
    return ids;
  }

  // Plane sets labels as a whole list, so one PATCH swaps them and the item never shows both or neither.
  private async labels(n: number, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const w = await this.item(n);
    const drop = new Set(await this.labelIds(remove.filter((l) => !add.includes(l))));
    const next = [...new Set([...w.label_ids.filter((id) => !drop.has(id)), ...(await this.labelIds(add))])];
    await this.client.request("PATCH", `${this.base}/work-items/${w.id}/`, { body: { label_ids: next } });
  }

  async listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    const id = (await this.labelMap()).get(label);
    return id ? this.open((w) => w.label_ids.includes(id)) : [];
  }
  async getIssue(_repo: string, n: number): Promise<GhIssue> {
    return this.toIssue(await this.item(n), await this.names());
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.open(() => true);
  }
  async commentIssue(_repo: string, n: number, body: string): Promise<number> {
    const w = await this.item(n);
    const c = await this.client.request<{ id: string }>("POST", `${this.base}/work-items/${w.id}/comments/`, {
      body: { comment_html: toHtml(body, this.seal, "comment") },
    });
    this.commentItem.set(c.id, w.id);
    return this.comments.number(c.id);
  }
  async editComment(_repo: string, id: number, body: string): Promise<void> {
    if (!this.comments.vendorId(id)) await this.listOpenIssues();
    const vendorId = this.comments.vendorId(id);
    const itemId = vendorId && this.commentItem.get(vendorId);
    if (!vendorId || !itemId) throw new Error(`plane: no comment ${id} on an open work item`);
    await this.client.request("PATCH", `${this.base}/work-items/${itemId}/comments/${vendorId}/`, {
      body: { comment_html: toHtml(body, this.seal, "comment") },
    });
  }
  addLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    return this.labels(n, labels, []);
  }
  // Removing a label the project lacks would create it; skip those.
  async removeLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    const have = await this.labelMap();
    return this.labels(
      n,
      [],
      labels.filter((l) => have.has(l)),
    );
  }
  async setStateLabel(_repo: string, n: number, current: string[], next: string): Promise<void> {
    const have = await this.labelMap();
    return this.labels(
      n,
      [next],
      current.filter((l) => l !== next && have.has(l)),
    );
  }
  async closeIssue(_repo: string, n: number): Promise<void> {
    const w = await this.item(n);
    await this.client.request("PATCH", `${this.base}/work-items/${w.id}/`, {
      body: { state_id: await this.stateIn("completed") },
    });
  }
  async reopenIssue(_repo: string, n: number): Promise<void> {
    const w = await this.item(n);
    await this.client.request("PATCH", `${this.base}/work-items/${w.id}/`, {
      body: { state_id: await this.stateIn("unstarted", "backlog") },
    });
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const w = await this.client.request<WorkItem>("POST", `${this.base}/work-items/`, {
      body: {
        name: title,
        description_html: toHtml(body, this.seal, "description"),
        label_ids: await this.labelIds(labels),
      },
    });
    this.bySequence.set(w.sequence_id, w.id);
    return w.sequence_id;
  }
  async listLabels(): Promise<string[]> {
    return [...(await this.labelMap()).keys()];
  }
  async ensureLabel(_repo: string, name: string, color: string, description: string): Promise<void> {
    await this.labelIds([name], color, description);
  }
  async currentLogin(): Promise<string> {
    return (await this.client.request<{ id: string }>("GET", "/api/v2/users/me/")).id;
  }
  // Matched by label id, and the activity must still name the label: a rename after the add would carry
  // the adder's trust to a new name. A label set at creation names the creator, unless edited since.
  async labeledBy(_repo: string, n: number, label: string): Promise<string | undefined> {
    const w = await this.item(n);
    const found = (await this.all<{ id: string; name: string; updated_at: string }>(`${this.base}/labels/`)).find(
      (l) => l.name === label,
    );
    if (!found || !w.label_ids.includes(found.id)) return undefined;
    const id = found.id;
    const rows = await this.all<{
      actor_id: string;
      field: string;
      new_value: string | null;
      new_identifier: string | null;
      created_at: string;
    }>(`${this.base}/work-items/${w.id}/activities/`, { field: "labels" });
    const adds = rows
      .filter((r) => r.field === "labels" && r.new_identifier === id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = adds.at(-1);
    if (!last) return found.updated_at > w.created_at ? undefined : w.created_by_id;
    return last.new_value === label ? last.actor_id : undefined;
  }
  // Read fresh on every call: a role is what lets a comment drive the factory, so a demotion counts at once.
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    const members = await this.all<{ member_id: string; role: number }>(`${this.base}/members/`);
    const tier = ROLE_TIERS[members.find((m) => m.member_id === login)?.role ?? 0];
    return tier ? workspaceRole(tier) : "none";
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.states();
      return { ok: true, detail: `plane ${this.spec.workspace} as ${await this.currentLogin()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof VendorHttpError || err instanceof Error ? err.message : String(err) };
    }
  }
}
