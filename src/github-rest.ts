// Issue reads and label/comment writes over REST. `gh issue list|edit|comment` are GraphQL, and two
// watchers drained that 5000/h bucket to zero, stalling every stage; REST has its own bucket.
import type { CommandResult, CommandRunner } from "./github";
import type { GhComment, GhIssue } from "./ports/scm";

interface RestIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  labels: ({ name: string } | string)[];
  comments: number;
  updated_at: string;
  pull_request?: unknown;
}

interface RestComment {
  id: number;
  html_url: string;
  user?: { login?: string } | null;
  author_association: string;
  body: string | null;
  created_at: string;
}

const PER_PAGE = 100;

export class RestIssues {
  // Comments change only when updated_at does, so a warm tick costs one list call, not one per issue.
  private readonly cache = new Map<string, { updatedAt: string; comments: GhComment[] }>();

  constructor(
    private readonly runner: CommandRunner,
    private readonly fail: (args: string[], result: CommandResult) => Promise<Error>,
  ) {}

  private async get<T>(args: string[]): Promise<T[]> {
    const full = ["api", "--paginate", "--slurp", ...args];
    const result = await this.runner.run(full);
    if (result.code !== 0) throw await this.fail(full, result);
    return (JSON.parse(result.stdout || "[]") as T[][]).flat();
  }

  async list(repo: string, label?: string): Promise<GhIssue[]> {
    const query = `state=open&per_page=${PER_PAGE}${label ? `&labels=${encodeURIComponent(label)}` : ""}`;
    const raw = (await this.get<RestIssue>([`repos/${repo}/issues?${query}`])).filter((i) => !i.pull_request);
    return Promise.all(raw.map((i) => this.shape(repo, i)));
  }

  async view(repo: string, number: number): Promise<GhIssue> {
    const args = ["api", `repos/${repo}/issues/${number}`];
    const result = await this.runner.run(args);
    if (result.code !== 0) throw await this.fail(args, result);
    return this.shape(repo, JSON.parse(result.stdout) as RestIssue);
  }

  private async shape(repo: string, i: RestIssue): Promise<GhIssue> {
    const key = `${repo}#${i.number}`;
    const hit = this.cache.get(key);
    let comments = hit && hit.updatedAt === i.updated_at ? hit.comments : undefined;
    if (!comments) {
      comments = i.comments === 0 ? [] : await this.comments(repo, i.number);
      this.cache.set(key, { updatedAt: i.updated_at, comments });
    }
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      labels: i.labels.map((l) => (typeof l === "string" ? { name: l } : { name: l.name })),
      comments,
      state: i.state === "closed" ? "CLOSED" : "OPEN",
      stateReason: i.state_reason ?? null,
    };
  }

  private async comments(repo: string, number: number): Promise<GhComment[]> {
    const raw = await this.get<RestComment>([`repos/${repo}/issues/${number}/comments?per_page=${PER_PAGE}`]);
    return raw.map((c) => ({
      id: c.id,
      url: c.html_url,
      author: c.user?.login ?? "",
      authorAssociation: c.author_association,
      body: c.body ?? "",
      createdAt: c.created_at,
    }));
  }

  async comment(repo: string, number: number, body: string): Promise<number | undefined> {
    const args = ["api", "-X", "POST", `repos/${repo}/issues/${number}/comments`, "-f", `body=${body}`, "--jq", ".id"];
    const result = await this.runner.run(args);
    if (result.code !== 0) throw await this.fail(args, result);
    const id = Number(result.stdout.trim());
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    const args = [
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${number}/labels`,
      ...labels.flatMap((l) => ["-f", `labels[]=${l}`]),
    ];
    const result = await this.runner.run(args);
    if (result.code !== 0) throw await this.fail(args, result);
  }

  // A label that is already gone is a 404; removing it twice must not fail the stage.
  async removeLabels(repo: string, number: number, labels: string[]): Promise<void> {
    for (const l of labels) {
      const args = ["api", "-X", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(l)}`];
      const result = await this.runner.run(args);
      if (result.code !== 0 && !/HTTP 404/.test(result.stderr)) throw await this.fail(args, result);
    }
  }
}
