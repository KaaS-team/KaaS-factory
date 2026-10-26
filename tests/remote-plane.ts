// A whole plane in memory for the remote-control tests: the dashboard with its access layer, a
// tracker fake that records every comment, and helpers to call it as a member, a phone or a runner.
import { createDashboard } from "../dashboard/server";
import { createAccess } from "../dashboard/plane/access";
import { PlaneStore, type Role } from "../dashboard/plane/store";
import { GitHub } from "../src/github";
import type { GhIssue, GhPr } from "../src/ports/scm";
import { FactoryState } from "../src/state";

export const TOKEN = "break-glass-token";
export const BASE = "https://plane.example";
// Every remote caller comes from off the box, as a phone or a runner would.
export const AWAY = "203.0.113.9";

export class TrackerGitHub extends GitHub {
  labels: Record<number, string> = {};
  posted: { issue: number; body: string }[] = [];
  created: { title: string; body: string; labels: string[] }[] = [];
  override async getIssue(_repo: string, number: number): Promise<GhIssue> {
    const label = this.labels[number];
    return { number, title: `task ${number}`, body: "", labels: label ? [{ name: label }] : [], comments: [] };
  }
  prs: GhPr[] = [];
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [];
  }
  override async listPrs(): Promise<GhPr[]> {
    return this.prs;
  }
  override async commentIssue(_repo: string, issue: number, body: string) {
    this.posted.push({ issue, body });
    return this.posted.length;
  }
  override async createIssue(_repo: string, title: string, body: string, labels: string[]) {
    this.created.push({ title, body, labels });
    return 40 + this.created.length;
  }
}

export function makePlane(github = new TrackerGitHub()) {
  const store = new PlaneStore();
  const access = createAccess({ token: TOKEN, store, env: {} });
  const state = new FactoryState(":memory:");
  const dashboard = createDashboard(
    state,
    github,
    "acme/widgets",
    false,
    "/nonexistent",
    undefined,
    undefined,
    undefined,
    access,
  );
  const member = (role: Role, login = `${role}-person`) => {
    store.setMember(login, role, "test");
    const id = crypto.randomUUID();
    store.openSession(id, login, 60_000);
    return `factory_session=${id}`;
  };
  // A value with a space is an Authorization header; anything else is a cookie.
  const call = (method: string, path: string, auth = "", body?: unknown) =>
    dashboard.handle(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
          ...(auth.includes(" ") ? { authorization: auth } : auth ? { cookie: auth } : {}),
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      }),
      AWAY,
    );
  // What a runner or the CLI on another machine uses as fetch: every request lands on this plane.
  const net = ((input: string | URL | Request, init?: RequestInit) =>
    dashboard.handle(
      new Request(String(input instanceof Request ? input.url : input), init),
      AWAY,
    )) as unknown as typeof fetch;
  return { dashboard, store, state, github, member, call, net, remote: dashboard.remote };
}

export const owner = `Bearer ${TOKEN}`;
export const cookieOf = (res: Response) => res.headers.getSetCookie()[0]!.split(";")[0]!;
