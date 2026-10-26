// TrackerPort over Linear's GraphQL API, for one team. Issue numbers are the team's (ENG-42 is 42),
// logins are Linear user ids, and labeledBy reads the issue history. Modeled on Linear's public
// schema; tests/trackers-linear.test.ts runs the contract against a fixture of it.

import type { GhComment, GhIssue, RepoRole, TrackerPort } from "../../ports/scm";
import {
  association,
  decodeBody,
  encodeBody,
  IdMap,
  memoOnce,
  type Seal,
  VendorClient,
  VendorHttpError,
  workspaceRole,
} from "./kit";

export interface LinearSpec {
  readonly kind: "linear";
  readonly team: string;
  readonly tokenEnv: string;
  readonly url?: string;
}

interface Node {
  id: string;
}
interface LinearIssue extends Node {
  number: number;
  title: string;
  description: string | null;
  state: { type: string };
  creator: Node | null;
  createdAt: string;
  labels: { nodes: Label[] };
  comments: { nodes: (Node & { body: string; createdAt: string; user: Node | null })[] };
}
interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const ISSUE = `id number title description state { type } creator { id } createdAt labels { nodes { id name updatedAt } }
  comments(first: 250) { nodes { id body createdAt user { id } } }`;

// Named operations, one per need: the fixture answers by name, and a reader sees every call Linear gets.
const Q = {
  viewer: "query Viewer { viewer { id } }",
  team: `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id
    states { nodes { id type position } } } } }`,
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE} } }`,
  issues: `query Issues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) {
    nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`,
  labels: `query Labels($after: String) { issueLabels(first: 250, after: $after) {
    nodes { id name updatedAt team { id } } pageInfo { hasNextPage endCursor } } }`,
  history: `query History($id: String!) { issue(id: $id) { creator { id }
    history(first: 250) { nodes { createdAt actor { id } addedLabelIds } } } }`,
  user: "query User($id: String!) { user(id: $id) { id admin guest active } }",
  commentCreate:
    "mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }",
  commentUpdate: `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) { success } }`,
  issueCreate: "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { issue { number } } }",
  issueUpdate: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success } }`,
  labelCreate: `mutation LabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { issueLabel { id name } } }`,
} as const;

const CLOSED = new Set(["completed", "canceled"]);

interface Label {
  id: string;
  name: string;
  updatedAt: string;
}

export class LinearTracker implements TrackerPort {
  private readonly client: VendorClient;
  private readonly seal: Seal = (s) => this.client.seal(s);
  private readonly comments = new IdMap();
  private teamCache?: Promise<{ id: string; done: string; open: string }>;

  constructor(
    private readonly spec: LinearSpec,
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.client = new VendorClient(
      "linear",
      spec.url ?? "https://api.linear.app",
      spec.tokenEnv,
      (t) => ({ authorization: t }),
      env,
    );
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await this.client.request<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", {
      body: { query, variables },
    });
    if (r.errors?.length || !r.data) throw new VendorHttpError(`linear: ${r.errors?.[0]?.message ?? "no data"}`, 200);
    return r.data;
  }

  private team() {
    this.teamCache ??= this.gql<{
      teams: { nodes: { id: string; states: { nodes: { id: string; type: string; position: number }[] } }[] };
    }>(Q.team, { key: this.spec.team }).then((d) => {
      const t = d.teams.nodes[0];
      if (!t) throw new Error(`linear: no team with key ${this.spec.team}`);
      const first = (...types: string[]) =>
        t.states.nodes.filter((s) => types.includes(s.type)).sort((a, b) => a.position - b.position)[0]?.id;
      const done = first("completed");
      const open = first("unstarted", "backlog");
      if (!done || !open) throw new Error(`linear: team ${this.spec.team} needs a completed and an unstarted state`);
      return { id: t.id, done, open };
    });
    return this.teamCache;
  }

  private key = (n: number) => `${this.spec.team}-${n}`;

  private readonly me = memoOnce(() => this.currentLogin());

  private async toIssue(raw: LinearIssue): Promise<GhIssue> {
    const self = await this.me();
    const comments: GhComment[] = [];
    for (const c of raw.comments.nodes) {
      const author = c.user?.id ?? "";
      comments.push({
        id: this.comments.number(c.id),
        author,
        authorAssociation: association(author ? await this.roleOf("", author) : "none"),
        body: decodeBody(c.body, author === self, this.seal, "comment"),
        createdAt: c.createdAt,
      });
    }
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const closed = CLOSED.has(raw.state.type);
    return {
      number: raw.number,
      title: raw.title,
      body: decodeBody(raw.description ?? "", raw.creator?.id === self, this.seal, "description"),
      labels: raw.labels.nodes.map((l) => ({ name: l.name })),
      comments,
      state: closed ? "CLOSED" : "OPEN",
      stateReason: closed ? (raw.state.type === "canceled" ? "NOT_PLANNED" : "COMPLETED") : null,
    };
  }

  private async raw(n: number): Promise<LinearIssue> {
    const d = await this.gql<{ issue: LinearIssue | null }>(Q.issue, { id: this.key(n) });
    if (!d.issue) throw new Error(`linear: no issue ${this.key(n)}`);
    return d.issue;
  }

  private async list(extra: Record<string, unknown>): Promise<GhIssue[]> {
    const filter = { team: { key: { eq: this.spec.team } }, state: { type: { nin: [...CLOSED] } }, ...extra };
    const out: GhIssue[] = [];
    let after: string | null = null;
    do {
      const d: { issues: Page<LinearIssue> } = await this.gql(Q.issues, { filter, after });
      for (const i of d.issues.nodes) out.push(await this.toIssue(i));
      after = d.issues.pageInfo.hasNextPage ? d.issues.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  private async allLabels(): Promise<Label[]> {
    const team = await this.team();
    const out: Label[] = [];
    let after: string | null = null;
    do {
      const d: { issueLabels: Page<Label & { team: Node | null }> } = await this.gql(Q.labels, {
        after,
      });
      out.push(...d.issueLabels.nodes.filter((l) => !l.team || l.team.id === team.id));
      after = d.issueLabels.pageInfo.hasNextPage ? d.issueLabels.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  // Label ids by name, creating any the team does not have yet.
  private async labelIds(names: string[], color = "ededed", description = ""): Promise<string[]> {
    if (names.length === 0) return [];
    const have = new Map((await this.allLabels()).map((l) => [l.name, l.id]));
    const ids: string[] = [];
    for (const name of names) {
      let id = have.get(name);
      if (!id) {
        const d = await this.gql<{ issueLabelCreate: { issueLabel: Node } }>(Q.labelCreate, {
          input: { name, color: `#${color}`, description, teamId: (await this.team()).id },
        });
        id = d.issueLabelCreate.issueLabel.id;
        have.set(name, id);
      }
      ids.push(id);
    }
    return ids;
  }

  private async update(n: number, input: Record<string, unknown>): Promise<void> {
    await this.gql(Q.issueUpdate, { id: (await this.raw(n)).id, input });
  }

  private async labels(n: number, add: string[], remove: string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const removed = new Map((await this.allLabels()).map((l) => [l.name, l.id]));
    await this.update(n, {
      addedLabelIds: await this.labelIds(add),
      removedLabelIds: remove.flatMap((l) => removed.get(l) ?? []),
    });
  }

  listIssuesByLabel(_repo: string, label: string): Promise<GhIssue[]> {
    return this.list({ labels: { name: { eq: label } } });
  }
  async getIssue(_repo: string, n: number): Promise<GhIssue> {
    return this.toIssue(await this.raw(n));
  }
  listOpenIssues(): Promise<GhIssue[]> {
    return this.list({});
  }
  async commentIssue(_repo: string, n: number, body: string): Promise<number> {
    const d = await this.gql<{ commentCreate: { comment: Node } }>(Q.commentCreate, {
      input: { issueId: (await this.raw(n)).id, body: encodeBody(body, this.seal, "comment") },
    });
    return this.comments.number(d.commentCreate.comment.id);
  }
  async editComment(_repo: string, id: number, body: string): Promise<void> {
    if (!this.comments.vendorId(id)) await this.listOpenIssues();
    const vendorId = this.comments.vendorId(id);
    if (!vendorId) throw new Error(`linear: no comment ${id} on an open issue of ${this.spec.team}`);
    await this.gql(Q.commentUpdate, { id: vendorId, input: { body: encodeBody(body, this.seal, "comment") } });
  }
  addLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    return this.labels(n, labels, []);
  }
  removeLabels(_repo: string, n: number, labels: string[]): Promise<void> {
    return this.labels(n, [], labels);
  }
  // One issueUpdate, so the issue is never seen with both labels or neither.
  setStateLabel(_repo: string, n: number, current: string[], next: string): Promise<void> {
    return this.labels(
      n,
      current.includes(next) ? [] : [next],
      current.filter((l) => l !== next),
    );
  }
  async closeIssue(_repo: string, n: number): Promise<void> {
    await this.update(n, { stateId: (await this.team()).done });
  }
  async reopenIssue(_repo: string, n: number): Promise<void> {
    await this.update(n, { stateId: (await this.team()).open });
  }
  async createIssue(_repo: string, title: string, body: string, labels: string[]): Promise<number> {
    const d = await this.gql<{ issueCreate: { issue: { number: number } } }>(Q.issueCreate, {
      input: {
        teamId: (await this.team()).id,
        title,
        description: encodeBody(body, this.seal, "description"),
        labelIds: await this.labelIds(labels),
      },
    });
    return d.issueCreate.issue.number;
  }
  async listLabels(): Promise<string[]> {
    return (await this.allLabels()).map((l) => l.name);
  }
  async ensureLabel(_repo: string, name: string, color: string, description: string): Promise<void> {
    await this.labelIds([name], color, description);
  }
  async currentLogin(): Promise<string> {
    return (await this.gql<{ viewer: Node }>(Q.viewer)).viewer.id;
  }
  // History keeps label ids, not names, so a label edited (renamed) after it was added names no one. A
  // label set at creation has no entry and names the creator, unless the label was edited since.
  async labeledBy(_repo: string, n: number, label: string): Promise<string | undefined> {
    const raw = await this.raw(n);
    const found =
      raw.labels.nodes.find((l) => l.name === label) ?? (await this.allLabels()).find((l) => l.name === label);
    if (!found) return undefined;
    const id = found.id;
    const d = await this.gql<{
      issue: {
        creator: Node | null;
        history: { nodes: { createdAt: string; actor: Node | null; addedLabelIds: string[] | null }[] };
      };
    }>(Q.history, { id: raw.id });
    const adds = d.issue.history.nodes
      .filter((h) => h.addedLabelIds?.includes(id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = adds.at(-1);
    if (last) return found.updatedAt > last.createdAt ? undefined : last.actor?.id;
    if (found.updatedAt > raw.createdAt) return undefined;
    return raw.labels.nodes.some((l) => l.id === id) ? d.issue.creator?.id : undefined;
  }
  async roleOf(_repo: string, login: string): Promise<RepoRole> {
    let user: { admin: boolean; guest: boolean; active: boolean } | null;
    try {
      user = (await this.gql<{ user: typeof user }>(Q.user, { id: login })).user;
    } catch (err) {
      // Linear answers an unknown id with a GraphQL error: not a member. Any transport failure throws.
      if (err instanceof VendorHttpError && err.status === 200) return "none";
      throw err;
    }
    return user?.active ? workspaceRole(user.admin ? "admin" : user.guest ? "guest" : "member") : "none";
  }
  async authStatus(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.team();
      return { ok: true, detail: `linear team ${this.spec.team} as ${await this.currentLogin()}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
