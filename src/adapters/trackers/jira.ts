// TrackerPort over Jira's REST API v2 (Cloud or Data Center), for one project. Issue numbers are the
// number in the key (SHOP-42), logins are account ids, and labeledBy reads the changelog. Modeled on
// developer.atlassian.com; tests/trackers-jira.test.ts runs the contract against a fixture of it.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import { association, decodeBody, encodeBody, IdMap, keyNumber, VendorClient, VendorHttpError } from "./kit";

export interface JiraSpec {
  readonly kind: "jira";
  readonly url: string;
  readonly project: string;
  readonly tokenEnv: string;
  readonly issueType?: string;
}

interface RawIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    labels: string[];
    status: { statusCategory: { key: string } };
    resolution: { name: string } | null;
    creator: { accountId: string };
  };
}
interface RawComment {
  id: string;
  body: string;
  created: string;
  author: { accountId: string };
}

// Resolutions that mean the work was dropped rather than done; Jira ships these names by default.
const NOT_DONE = new Set(["won't do", "won't fix", "duplicate", "cannot reproduce", "declined"]);
const FIELDS = ["summary", "description", "labels", "status", "resolution", "creator"];
const jqlString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Cloud takes `email:api-token` as Basic auth; Data Center takes a personal access token as Bearer.
export function jiraAuth(token: string): Record<string, string> {
  return {
    authorization: token.includes(":") ? `Basic ${Buffer.from(token).toString("base64")}` : `Bearer ${token}`,
  };
}

export class JiraTracker implements TrackerPort {
  private readonly client: VendorClient;
  private readonly comments = new IdMap();
  // Each comment's issue key, since Jira's comment routes sit under the issue.
  private readonly commentKey = new Map<string, string>();
  // Jira lists a label only while some issue carries one; these were ensured or applied here.
  private readonly ensured = new Set<string>();
  private projectId?: Promise<string>;

  constructor(
    private readonly spec: JiraSpec,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = new VendorClient("jira", spec.url, spec.tokenEnv, jiraAuth, env);
  }

  private key = (n: number) => `${this.spec.project}-${n}`;

  private async search(jql: string): Promise<RawIssue[]> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.client.request<{ issues: RawIssue[]; nextPageToken?: string }>(
        "POST",
        "/rest/api/2/search/jql",
        { body: { jql, fields: FIELDS, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) } },
      );
      out.push(...page.issues);
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
    return out;
  }

  private async pages<T>(path: string, field: string): Promise<T[]> {
    const out: T[] = [];
    for (let startAt = 0; ; ) {
      const page = await this.client.request<Record<string, unknown> & { total?: number; isLast?: boolean }>(
        "GET",
        path,
        { query: { startAt: String(startAt), maxResults: "100" } },
      );
      const rows = (page[field] ?? []) as T[];
      out.push(...rows);
      startAt += rows.length;
      if (rows.length === 0 || page.isLast === true || (page.total !== undefined && startAt >= page.total)) return out;
    }
  }

  private async toIssue(raw: RawIssue): Promise<GhIssue> {
    const rows = await this.pages<RawComment>(`/rest/api/2/issue/${raw.key}/comment`, "comments");
    const comments: GhComment[] = [];
    for (const c of rows) {
      this.commentKey.set(c.id, raw.key);
      comments.push({
        id: this.comments.number(c.id),
        author: c.author.accountId,
        authorAssociation: association(await this.roleOf("", c.author.accountId)),
        body: decodeBody(c.body),
        createdAt: new Date(c.created).toISOString(),
      });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const f = raw.fields;
    const closed = f.status.statusCategory.key === "done";
    return {
      number: keyNumber(raw.key),
      title: f.summary,
      body: decodeBody(f.description ?? ""),
      labels: f.labels.map((name) => ({ name })),
      comments,
      state: closed ? "CLOSED" : "OPEN",
      stateReason: closed ? (NOT_DONE.has(f.resolution?.name.toLowerCase() ?? "") ? "NOT_PLANNED" : "COMPLETED") : null,
    };
  }

  private async open(label?: string): Promise<GhIssue[]> {
    const jql = [`project = ${jqlString(this.spec.project)}`, "statusCategory != Done"];
    if (label) jql.push(`labels = ${jqlString(label)}`);
    const out: GhIssue[] = [];
    for (const raw of await this.search(`${jql.join(" AND ")} ORDER BY created ASC`)) out.push(await this.toIssue(raw));
    return out;
  }

  private raw(n: number): Promise<RawIssue> {
    return this.client.request<RawIssue>("GET", `/rest/api/2/issue/${this.key(n)}`, {
      query: { fields: FIELDS.join(",") },
    });
  }

  // One update with both lists, so the issue never shows both state labels or neither.
  private async labels(n: number, add: string[], remove: string[]): Promise<void> {
    const ops = [
      ...add.map((l) => ({ add: l })),
      ...remove.filter((l) => !add.includes(l)).map((l) => ({ remove: l })),
    ];
    if (ops.length === 0) return;
    for (const l of add) this.ensured.add(l);
    await this.client.request("PUT", `/rest/api/2/issue/${this.key(n)}`, { body: { update: { labels: ops } } });
  }

  private async transition(n: number, category: string): Promise<void> {
    const { transitions } = await this.client.request<{
      transitions: { id: string; to: { statusCategory: { key: string } } }[];
    }>("GET", `/rest/api/2/issue/${this.key(n)}/transitions`);
    const t = transitions.find((x) => x.to.statusCategory.key === category);
    if (!t) throw new Error(`jira: ${this.key(n)} has no transition to a ${category} status`);
    await this.client.request("POST", `/rest/api/2/issue/${this.key(n)}/transitions`, {
      body: { transition: { id: t.id } },
    });
  }

  listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return this.open(label);
  }
  async getIssue(_repo: string, n: number): Promise<GhIssue> {
    return this.toIssue(await this.raw(n));
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.open();
  }
  async commentIssue(_repo: string, n: number, body: string): Promise<number> {
    const key = this.key(n);
    const c = await this.client.request<{ id: string }>("POST", `/rest/api/2/issue/${key}/comment`, {
      body: { body: encodeBody(body) },
    });
    this.commentKey.set(c.id, key);
    return this.comments.number(c.id);
  }
  async editComment(_repo: string, id: number, body: string): Promise<void> {
    if (!this.comments.vendorId(id)) await this.listOpenIssues();
    const vendorId = this.comments.vendorId(id);
    const key = vendorId && this.commentKey.get(vendorId);
    if (!vendorId || !key) throw new Error(`jira: no comment ${id} on an open issue`);
    await this.client.request("PUT", `/rest/api/2/issue/${key}/comment/${vendorId}`, {
      body: { body: encodeBody(body) },
    });
  }
  addLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    return this.labels(n, labels, []);
  }
  removeLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    return this.labels(n, [], labels);
  }
  setStateLabel(_repo: string, n: number, current: string[], next: string): Promise<void> {
    return this.labels(n, [next], current);
  }
  closeIssue(_repo: string, n: number): Promise<void> {
    return this.transition(n, "done");
  }
  reopenIssue(_repo: string, n: number): Promise<void> {
    return this.transition(n, "new");
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const { key } = await this.client.request<{ key: string }>("POST", "/rest/api/2/issue", {
      body: {
        fields: {
          project: { key: this.spec.project },
          issuetype: { name: this.spec.issueType ?? "Task" },
          summary: title,
          description: encodeBody(body),
          labels,
        },
      },
    });
    return keyNumber(key);
  }
  async listLabels(): Promise<string[]> {
    const used = await this.pages<string>("/rest/api/2/label", "values");
    return [...new Set([...used, ...this.ensured])];
  }
  // Jira has no label objects to create, color or describe: any string is a label.
  async ensureLabel(_repo: string, name: string): Promise<void> {
    this.ensured.add(name);
  }
  async currentLogin(): Promise<string> {
    return (await this.client.request<{ accountId: string }>("GET", "/rest/api/2/myself")).accountId;
  }
  // A label set at creation has no changelog entry, so it names the issue's creator.
  async labeledBy(_repo: string, n: number, label: string): Promise<string | undefined> {
    const raw = await this.raw(n);
    const history = await this.pages<{
      author: { accountId: string };
      created: string;
      items: { field: string; fromString: string | null; toString: string | null }[];
    }>(`/rest/api/2/issue/${raw.key}/changelog`, "values");
    const words = (s: string | null) => (s ?? "").split(/\s+/);
    const adds = history
      .filter((h) =>
        h.items.some(
          (i) => i.field === "labels" && words(i.toString).includes(label) && !words(i.fromString).includes(label),
        ),
      )
      .sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    if (adds.length > 0) return adds.at(-1)!.author.accountId;
    return raw.fields.labels.includes(label) ? raw.fields.creator.accountId : undefined;
  }
  // Read fresh on every call: a role is what lets a comment drive the factory, so a demotion counts at once.
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    this.projectId ??= this.client
      .request<{ id: string }>("GET", `/rest/api/2/project/${this.spec.project}`)
      .then((p) => p.id);
    const projectId = await this.projectId;
    let granted: { permission: string; projects?: number[] }[];
    try {
      granted = (
        await this.client.request<{ projectPermissions: { permission: string; projects?: number[] }[] }>(
          "POST",
          "/rest/api/2/permissions/check",
          {
            body: {
              accountId: login,
              projectPermissions: [
                {
                  permissions: ["ADMINISTER_PROJECTS", "EDIT_ISSUES", "BROWSE_PROJECTS"],
                  projects: [Number(projectId)],
                },
              ],
            },
          },
        )
      ).projectPermissions;
    } catch (err) {
      // An account Jira does not know is a stranger; any other failure must not pass as one.
      if (err instanceof VendorHttpError && (err.status === 400 || err.status === 404)) return "none";
      throw err;
    }
    const has = (p: string) => granted.some((g) => g.permission === p && g.projects?.includes(Number(projectId)));
    if (has("ADMINISTER_PROJECTS")) return "admin";
    if (has("EDIT_ISSUES")) return "write";
    return has("BROWSE_PROJECTS") ? "read" : "none";
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.client.request("GET", `/rest/api/2/project/${this.spec.project}`);
      return { ok: true, detail: `jira ${this.spec.project} as ${await this.currentLogin()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
