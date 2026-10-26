// TrackerPort over Asana's API 1.0, for one project. Issue numbers and comment ids are Asana gids,
// logins are user gids, labels are workspace tags, and labeledBy reads the task's stories. Modeled on
// developers.asana.com; tests/trackers-asana.test.ts runs the contract against a fixture of it.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import { association, decodeBody, encodeBody, memoOnce, VendorClient, workspaceRole } from "./kit";

export interface AsanaSpec {
  readonly kind: "asana";
  readonly workspace: string;
  readonly project: string;
  readonly tokenEnv: string;
  readonly url?: string;
}

interface RawTask {
  gid: string;
  name: string;
  notes: string;
  completed: boolean;
  tags: { gid: string; name: string }[];
  created_by: { gid: string } | null;
  projects: { gid: string }[];
}
interface Story {
  gid: string;
  resource_subtype: string;
  text: string;
  created_at: string;
  created_by: { gid: string } | null;
  tag?: { gid: string } | null;
}

const TASK_FIELDS = "name,notes,completed,tags.name,created_by.gid,projects.gid";
// An added_to_tag story's text, which records the tag's name when it was added.
const TAG_STORY = /^added (?:this task )?to (.+)$/;
const STORY_FIELDS = "resource_subtype,text,created_at,created_by.gid,tag.gid";

// Asana gids are decimal strings; one past a safe integer would round, and an edit would hit the wrong one.
export function gidNumber(gid: string): number {
  const n = Number(gid);
  if (!/^\d+$/.test(gid) || !Number.isSafeInteger(n))
    throw new Error(`asana: gid ${JSON.stringify(gid)} is not a safe integer`);
  return n;
}

export class AsanaTracker implements TrackerPort {
  private readonly client: VendorClient;
  private readonly seen = new Set<number>();

  constructor(
    private readonly spec: AsanaSpec,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = new VendorClient(
      "asana",
      spec.url ?? "https://app.asana.com/api/1.0",
      spec.tokenEnv,
      (t) => ({ authorization: `Bearer ${t}` }),
      env,
    );
  }

  private async one<T>(method: string, path: string, data?: unknown, query?: Record<string, string>): Promise<T> {
    return (
      await this.client.request<{ data: T }>(method, path, { query, body: data === undefined ? undefined : { data } })
    ).data;
  }

  private async all<T>(path: string, query: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    do {
      const page = await this.client.request<{ data: T[]; next_page: { offset: string } | null }>("GET", path, {
        query: { limit: "100", ...query, ...(offset ? { offset } : {}) },
      });
      out.push(...page.data);
      offset = page.next_page?.offset;
    } while (offset);
    return out;
  }

  // Gids are global to the workspace, so a number from issue text could name a task in another project.
  private async task(n: number): Promise<RawTask> {
    const raw = await this.one<RawTask>("GET", `/tasks/${n}`, undefined, { opt_fields: TASK_FIELDS });
    if (!raw.projects?.some((p) => p.gid === this.spec.project))
      throw new Error(`asana: task ${n} is not in project ${this.spec.project}`);
    return raw;
  }

  private async scoped(n: number): Promise<string> {
    return (await this.task(n)).gid;
  }

  private saw(id: number): number {
    this.seen.add(id);
    return id;
  }

  private stories(gid: string): Promise<Story[]> {
    return this.all<Story>(`/tasks/${gid}/stories`, { opt_fields: STORY_FIELDS });
  }

  private readonly me = memoOnce(() => this.currentLogin());

  private async toIssue(raw: RawTask): Promise<GhIssue> {
    const self = await this.me();
    const comments: GhComment[] = [];
    for (const s of await this.stories(raw.gid)) {
      if (s.resource_subtype !== "comment_added") continue;
      const author = s.created_by?.gid ?? "";
      comments.push({
        id: this.saw(gidNumber(s.gid)),
        author,
        authorAssociation: association(author ? await this.roleOf("", author) : "none"),
        body: decodeBody(s.text, author !== "" && author === self),
        createdAt: new Date(s.created_at).toISOString(),
      });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Asana has only a completed flag, so a closed task always reads as done.
    return {
      number: gidNumber(raw.gid),
      title: raw.name,
      body: decodeBody(raw.notes, raw.created_by?.gid === self),
      labels: raw.tags.map((t) => ({ name: t.name })),
      comments,
      state: raw.completed ? "CLOSED" : "OPEN",
      stateReason: raw.completed ? "COMPLETED" : null,
    };
  }

  private async open(filter: (t: RawTask) => boolean): Promise<GhIssue[]> {
    // completed_since=now is how Asana lists only the tasks that are not done.
    const rows = await this.all<RawTask>(`/projects/${this.spec.project}/tasks`, {
      completed_since: "now",
      opt_fields: TASK_FIELDS,
    });
    const out: GhIssue[] = [];
    for (const t of rows) if (!t.completed && filter(t)) out.push(await this.toIssue(t));
    return out;
  }

  private async tagMap(): Promise<Map<string, string>> {
    const rows = await this.all<{ gid: string; name: string }>(`/workspaces/${this.spec.workspace}/tags`, {
      opt_fields: "name",
    });
    return new Map(rows.map((t) => [t.name, t.gid]));
  }

  private async tagIds(names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const have = await this.tagMap();
    const ids: string[] = [];
    for (const name of names) {
      let gid = have.get(name);
      if (!gid) {
        gid = (await this.one<{ gid: string }>("POST", "/tags", { name, workspace: this.spec.workspace })).gid;
        have.set(name, gid);
      }
      ids.push(gid);
    }
    return ids;
  }

  listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return this.open((t) => t.tags.some((x) => x.name === label));
  }
  async getIssue(_repo: string, n: number): Promise<GhIssue> {
    return this.toIssue(await this.task(n));
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.open(() => true);
  }
  async commentIssue(_repo: string, n: number, body: string): Promise<number> {
    const gid = await this.scoped(n);
    return this.saw(
      gidNumber((await this.one<{ gid: string }>("POST", `/tasks/${gid}/stories`, { text: encodeBody(body) })).gid),
    );
  }
  // Only a comment seen on a task in this project, for the same reason as task().
  async editComment(_repo: string, id: number, body: string): Promise<void> {
    if (!this.seen.has(id)) await this.listOpenIssues();
    if (!this.seen.has(id)) throw new Error(`asana: no comment ${id} on an open task in project ${this.spec.project}`);
    await this.one("PUT", `/stories/${id}`, { text: encodeBody(body) });
  }
  async addLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    const gid = await this.scoped(n);
    for (const tag of await this.tagIds(labels)) await this.one("POST", `/tasks/${gid}/addTag`, { tag });
  }
  async removeLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    const task = await this.task(n);
    for (const t of task.tags.filter((x) => labels.includes(x.name)))
      await this.one("POST", `/tasks/${task.gid}/removeTag`, { tag: t.gid });
  }
  // Asana tags one at a time, so the new state goes on first: a task may show both for a moment, never neither.
  async setStateLabel(repo: string, n: number, current: string[], next: string): Promise<void> {
    await this.addLabels(repo, n, [next]);
    await this.removeLabels(
      repo,
      n,
      current.filter((l) => l !== next),
    );
  }
  async closeIssue(_repo: string, n: number): Promise<void> {
    await this.one("PUT", `/tasks/${await this.scoped(n)}`, { completed: true });
  }
  async reopenIssue(_repo: string, n: number): Promise<void> {
    await this.one("PUT", `/tasks/${await this.scoped(n)}`, { completed: false });
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const t = await this.one<{ gid: string }>("POST", "/tasks", {
      name: title,
      notes: encodeBody(body),
      projects: [this.spec.project],
      workspace: this.spec.workspace,
      tags: await this.tagIds(labels),
    });
    return gidNumber(t.gid);
  }
  async listLabels(): Promise<string[]> {
    return [...(await this.tagMap()).keys()];
  }
  // Asana tag colors are a fixed palette of names, so the GitHub hex color and description are not carried.
  async ensureLabel(_repo: string, name: string, _color?: string, _description?: string): Promise<void> {
    await this.tagIds([name]);
  }
  async currentLogin(): Promise<string> {
    return (await this.one<{ gid: string }>("GET", "/users/me")).gid;
  }
  // Matched by tag gid, and the story must still name the label: a tag renamed after it was added would
  // carry the adder's trust to a new name, so it names no one. A tag set at creation names the creator.
  async labeledBy(_repo: string, n: number, label: string): Promise<string | undefined> {
    const t = await this.task(n);
    const tag = t.tags.find((x) => x.name === label);
    if (!tag) return undefined;
    const adds = (await this.stories(t.gid))
      .filter((s) => s.resource_subtype === "added_to_tag" && s.tag?.gid === tag.gid)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const last = adds.at(-1);
    if (!last) return t.created_by?.gid;
    return TAG_STORY.exec(last.text)?.[1] === label ? last.created_by?.gid : undefined;
  }
  // Read fresh on every call: a role is what lets a comment drive the factory, so a demotion counts at once.
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    const [m] = await this.all<{ is_admin: boolean; is_guest: boolean; is_active: boolean }>(
      `/workspaces/${this.spec.workspace}/workspace_memberships`,
      { user: login, opt_fields: "is_admin,is_guest,is_active" },
    );
    if (!m?.is_active) return "none";
    return workspaceRole(m.is_admin ? "admin" : m.is_guest ? "guest" : "member");
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.one("GET", `/projects/${this.spec.project}`, undefined, { opt_fields: "name" });
      return { ok: true, detail: `asana project ${this.spec.project} as ${await this.currentLogin()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
