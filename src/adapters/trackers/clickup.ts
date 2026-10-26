// TrackerPort over ClickUp's API v2, for one List. Issue numbers are task ids read as base 36, logins
// are user ids, and labels are space tags. ClickUp has no public activity history, so labeledBy fails
// closed unless labelTrust opts in. Modeled on developer.clickup.com; tests/trackers-clickup.test.ts.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import {
  association,
  decodeBody,
  encodeBody,
  memoOnce,
  type Seal,
  VendorClient,
  VendorHttpError,
  workspaceRole,
} from "./kit";

export interface ClickUpSpec {
  readonly kind: "clickup";
  readonly workspace: string;
  readonly list: string;
  readonly tokenEnv: string;
  readonly url?: string;
  // "creator" credits any tag on a task to the task's creator: anyone who can tag it counts as them.
  readonly labelTrust?: "none" | "creator";
}

interface RawTask {
  id: string;
  name: string;
  markdown_description?: string | null;
  description?: string | null;
  status: { status: string; type: string };
  tags: { name: string }[];
  creator: { id: number };
  list: { id: string };
}

// ClickUp has no resolution field, so a closed status whose name says the work was dropped is not planned.
const DROPPED = /cancel|won'?t|not planned|declined|duplicate/i;
const CLOSED_TYPES = new Set(["closed", "done"]);
const ROLE_TIERS: Record<number, "admin" | "member" | "guest"> = { 1: "admin", 2: "admin", 3: "member", 4: "guest" };

export function taskNumber(id: string): number {
  const n = Number.parseInt(id, 36);
  if (!/^[0-9a-z]+$/.test(id) || !Number.isSafeInteger(n))
    throw new Error(`clickup: task id ${JSON.stringify(id)} is not a base-36 number`);
  return n;
}

export class ClickUpTracker implements TrackerPort {
  private readonly client: VendorClient;
  private readonly seal: Seal = (s) => this.client.seal(s);
  private readonly seen = new Set<number>();
  private listCache?: Promise<{ space: string; statuses: { status: string; type: string }[] }>;

  constructor(
    private readonly spec: ClickUpSpec,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = new VendorClient(
      "clickup",
      spec.url ?? "https://api.clickup.com",
      spec.tokenEnv,
      (t) => ({ authorization: t }),
      env,
    );
  }

  private list() {
    this.listCache ??= this.client
      .request<{ space: { id: string }; statuses: { status: string; type: string }[] }>(
        "GET",
        `/api/v2/list/${this.spec.list}`,
      )
      .then((l) => ({ space: l.space.id, statuses: l.statuses }));
    return this.listCache;
  }

  private async status(...types: string[]): Promise<string> {
    // Closing means done, so a status named for dropped work is skipped.
    const s = (await this.list()).statuses.find((x) => types.includes(x.type) && !DROPPED.test(x.status));
    if (!s) throw new Error(`clickup: list has no ${types.join(" or ")} status`);
    return s.status;
  }

  // Task ids are global to the workspace, so a number from issue text could name a task in another List.
  private async task(n: number): Promise<RawTask> {
    const raw = await this.client.request<RawTask>("GET", `/api/v2/task/${n.toString(36)}`, {
      query: { include_markdown_description: "true" },
    });
    if (raw.list?.id !== this.spec.list) throw new Error(`clickup: task ${n} is not in list ${this.spec.list}`);
    return raw;
  }

  private async scoped(n: number): Promise<string> {
    return (await this.task(n)).id;
  }

  private saw(id: number): number {
    this.seen.add(id);
    return id;
  }

  private readonly me = memoOnce(() => this.currentLogin());

  private async toIssue(raw: RawTask): Promise<GhIssue> {
    const self = await this.me();
    const { comments: rows } = await this.client.request<{
      comments: { id: string; comment_text: string; date: string; user: { id: number } }[];
    }>("GET", `/api/v2/task/${raw.id}/comment`);
    const comments: GhComment[] = [];
    for (const c of rows) {
      const author = String(c.user.id);
      comments.push({
        id: this.saw(commentNumber(c.id)),
        author,
        authorAssociation: association(await this.roleOf("", author)),
        body: decodeBody(c.comment_text, author === self, this.seal),
        createdAt: new Date(Number(c.date)).toISOString(),
      });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const closed = CLOSED_TYPES.has(raw.status.type);
    return {
      number: taskNumber(raw.id),
      title: raw.name,
      body: decodeBody(raw.markdown_description ?? raw.description ?? "", String(raw.creator?.id) === self, this.seal),
      labels: raw.tags.map((t) => ({ name: t.name })),
      comments,
      state: closed ? "CLOSED" : "OPEN",
      stateReason: closed ? (DROPPED.test(raw.status.status) ? "NOT_PLANNED" : "COMPLETED") : null,
    };
  }

  private async open(tag?: string): Promise<GhIssue[]> {
    const out: GhIssue[] = [];
    for (let page = 0; ; page++) {
      const query: Record<string, string> = { page: String(page), include_markdown_description: "true" };
      if (tag) query["tags[]"] = tag;
      const res = await this.client.request<{ tasks: RawTask[]; last_page?: boolean }>(
        "GET",
        `/api/v2/list/${this.spec.list}/task`,
        {
          query,
        },
      );
      for (const t of res.tasks) if (!CLOSED_TYPES.has(t.status.type)) out.push(await this.toIssue(t));
      if (res.last_page !== false || res.tasks.length === 0) return out;
    }
  }

  private async spaceTags(): Promise<string[]> {
    const { tags } = await this.client.request<{ tags: { name: string }[] }>(
      "GET",
      `/api/v2/space/${(await this.list()).space}/tag`,
    );
    return tags.map((t) => t.name);
  }

  private async ensureTags(names: string[], color = "ededed"): Promise<void> {
    if (names.length === 0) return;
    const have = new Set(await this.spaceTags());
    const space = (await this.list()).space;
    for (const name of names.filter((x) => !have.has(x)))
      await this.client.request("POST", `/api/v2/space/${space}/tag`, {
        body: { tag: { name, tag_fg: "#000000", tag_bg: `#${color}` } },
      });
  }

  listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return this.open(label);
  }
  async getIssue(_repo: string, n: number): Promise<GhIssue> {
    return this.toIssue(await this.task(n));
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.open();
  }
  async commentIssue(_repo: string, n: number, body: string): Promise<number> {
    const c = await this.client.request<{ id: string | number }>(
      "POST",
      `/api/v2/task/${await this.scoped(n)}/comment`,
      {
        body: { comment_text: encodeBody(body, this.seal), notify_all: false },
      },
    );
    return this.saw(commentNumber(String(c.id)));
  }
  // Only a comment seen on a task in this List, for the same reason as task().
  async editComment(_repo: string, id: number, body: string): Promise<void> {
    if (!this.seen.has(id)) await this.listOpenIssues();
    if (!this.seen.has(id)) throw new Error(`clickup: no comment ${id} on an open task in list ${this.spec.list}`);
    await this.client.request("PUT", `/api/v2/comment/${id}`, { body: { comment_text: encodeBody(body, this.seal) } });
  }
  async addLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    const id = await this.scoped(n);
    await this.ensureTags(labels);
    for (const l of labels) await this.client.request("POST", `/api/v2/task/${id}/tag/${encodeURIComponent(l)}`);
  }
  async removeLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    const t = await this.task(n);
    const on = new Set(t.tags.map((x) => x.name));
    for (const l of labels.filter((x) => on.has(x)))
      await this.client.request("DELETE", `/api/v2/task/${t.id}/tag/${encodeURIComponent(l)}`);
  }
  // ClickUp tags one at a time, so the new state goes on first: a task may show both for a moment, never neither.
  async setStateLabel(repo: string, n: number, current: string[], next: string): Promise<void> {
    await this.addLabels(repo, n, [next]);
    await this.removeLabels(
      repo,
      n,
      current.filter((l) => l !== next),
    );
  }
  async closeIssue(_repo: string, n: number): Promise<void> {
    await this.client.request("PUT", `/api/v2/task/${await this.scoped(n)}`, {
      body: { status: await this.status("closed", "done") },
    });
  }
  async reopenIssue(_repo: string, n: number): Promise<void> {
    await this.client.request("PUT", `/api/v2/task/${await this.scoped(n)}`, {
      body: { status: await this.status("open") },
    });
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    await this.ensureTags(labels);
    const t = await this.client.request<{ id: string }>("POST", `/api/v2/list/${this.spec.list}/task`, {
      body: { name: title, markdown_content: encodeBody(body, this.seal), tags: labels },
    });
    return taskNumber(t.id);
  }
  listLabels(): Promise<string[]> {
    return this.spaceTags();
  }
  ensureLabel(_repo: string, name: string, color: string): Promise<void> {
    return this.ensureTags([name], color);
  }
  async currentLogin(): Promise<string> {
    return String((await this.client.request<{ user: { id: number } }>("GET", "/api/v2/user")).user.id);
  }
  async labeledBy(_repo: string, n: number, label: string): Promise<string | undefined> {
    if (this.spec.labelTrust !== "creator") return undefined;
    const t = await this.task(n);
    return t.tags.some((x) => x.name === label) ? String(t.creator.id) : undefined;
  }
  // Read fresh on every call: a role is what lets a comment drive the factory, so a demotion counts at once.
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    const { team } = await this.client.request<{ team: { members: { user: { id: number; role: number } }[] } }>(
      "GET",
      `/api/v2/team/${this.spec.workspace}`,
    );
    const tier = ROLE_TIERS[team.members.find((m) => String(m.user.id) === login)?.user.role ?? 0];
    return tier ? workspaceRole(tier) : "none";
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.list();
      const trust = this.spec.labelTrust === "creator" ? "" : "; label triggers off (no activity API)";
      return { ok: true, detail: `clickup list ${this.spec.list} as ${await this.currentLogin()}${trust}` };
    } catch (err) {
      return { ok: false, detail: err instanceof VendorHttpError || err instanceof Error ? err.message : String(err) };
    }
  }
}

// ClickUp comment ids are decimal strings, so the number is the id itself and an edit needs no lookup.
function commentNumber(id: string): number {
  const n = Number(id);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(n))
    throw new Error(`clickup: comment id ${JSON.stringify(id)} is not a safe integer`);
  return n;
}
