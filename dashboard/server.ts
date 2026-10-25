// The cockpit (plan section 2). Bun.serve, one static page, JSON API + SSE
// read from state.ts. No second source of truth: this server never invents
// state, it reads what watch.ts wrote and posts replies through github.ts as
// the signed-in `gh` user. /api/board is the exception on purpose — it
// reads GitHub labels directly (dashboard/board.ts), so the board still
// works with no local SQLite at all (a CI/VM run with no watcher on this
// machine).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScmPort } from "../src/github";
import { makeScm } from "../src/scm";
import { FactoryState, DEFAULT_DB_PATH } from "../src/state";
import { parseChatOps } from "../src/chatops";
import { buildBoard } from "./board";
import { LABEL } from "../src/labels";
import { InboxError, act, buildInbox, learningPrItems, parkReasons, type InboxAction } from "../src/inbox";
import { plain } from "../src/display";
import { agentCatalog } from "../src/agents/docs";
import { agentChecks } from "../src/doctor";
import { versionOf, which } from "../src/probes";
import { DEFAULT_CONFIG, type FactoryConfig } from "../src/config";
import { defaultStatePath, discoverRepos, streamPath, transcriptPath, workspacesDir } from "../src/paths";
import { liveItems, proofView } from "./run-page";
import { runDir, readGateEvidence, readStageArtifacts } from "../src/artifacts";
import { ciStatusNow } from "../src/ci";
import { attemptMerge, decideOperatorMerge, renderOperatorAuditComment } from "../src/merge-policy";
import { analytics } from "./analytics";
import { NO_PROJECT, settingsView, workflowsView, type DashboardProject } from "./project";
import { harnessReport } from "../src/harness";
import {
  readCapped,
  readDelivery,
  signatureMatches,
  WAKING_EVENTS,
  WEBHOOK_MAX_BYTES,
  WEBHOOK_SECRET_ENV,
} from "../src/webhook";
import { EVENT_SIGNATURE_HEADER, isExternalEventType, parseEvent, verifyEvent } from "../src/core/event";
import { eventsInboundSecretEnv } from "../src/config";

// GitHub cannot hold a dashboard token, so this route authenticates by HMAC
// instead (src/webhook.ts), and is the one public route reachable from off
// the box once FACTORY_WEBHOOK_SECRET is set.
const WEBHOOK_ROUTE = "POST /webhook/github";
const webhookSecret = () => process.env[WEBHOOK_SECRET_ENV] ?? "";
// Other KaaS apps POST CloudEvents here, signed with x-kaas-signature (docs/events.md).
// Public for the same reason: it authenticates by HMAC, and is off until the secret is set.
const EVENTS_ROUTE = "POST /events";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.FACTORY_DASHBOARD_PORT ?? 4100);
const DB_PATH = process.env.FACTORY_DB_PATH ?? DEFAULT_DB_PATH;
const REPO = process.env.FACTORY_REPO ?? "";
// Audit finding #16: the dashboard binds 127.0.0.1 by default (see the bottom
// of this file) and refuses a non-loopback caller unless this token is set.
// Read at module scope so createDashboard and bin/factory's cmdDashboard
// both pick it up from the process env.
const DASHBOARD_TOKEN = process.env.FACTORY_DASHBOARD_TOKEN ?? "";
const BOARD_CACHE_MS = 10_000;

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// Compare digests so the check takes the same time wherever the strings differ.
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const SESSION_COOKIE = "factory_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 1000;

function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

// The only routes reachable without a token. Everything else is default-deny;
// tests/dashboard-routes.test.ts walks every route against this list.
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /",
  "GET /assets",
  "POST /api/session",
  WEBHOOK_ROUTE,
  EVENTS_ROUTE,
];

const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
};

export const ARTIFACT_LIMIT = 1024 * 1024;

function plainRun<T extends { title: string; reason?: string | null }>(run: T): T {
  return { ...run, title: plain(run.title), ...(run.reason ? { reason: plain(run.reason) } : {}) };
}

// The agent name and kill reason come from config and from what an agent printed.
function plainStage<T extends { agent: string; killed_reason: string | null }>(s: T): T {
  return { ...s, agent: plain(s.agent), killed_reason: s.killed_reason === null ? null : plain(s.killed_reason) };
}

function plainIssue<T extends { title: string; body: string; comments: { body: string }[] }>(issue: T): T {
  return {
    ...issue,
    title: plain(issue.title),
    body: plain(issue.body),
    comments: issue.comments.map((c) => ({ ...c, body: plain(c.body) })),
  };
}

export function createDashboard(
  state: FactoryState,
  github: ScmPort,
  repo: string,
  autoApproveDefault = false,
  workspaces = workspacesDir(process.env, repo || undefined),
  fleet: Pick<FactoryConfig, "agents" | "stages"> = DEFAULT_CONFIG,
  probes: { which: typeof which; versionOf: typeof versionOf } = { which, versionOf },
  project?: DashboardProject,
) {
  const indexHtml = readFileSync(join(here, "public", "index.html"), "utf8");
  // Read by name on every request; the value is never logged or returned.
  const eventsSecret = () => process.env[eventsInboundSecretEnv(project?.config)] ?? "";

  const sessions = new Map<string, number>();
  const issuesCache = new Map<string, { at: number; issues: Awaited<ReturnType<ScmPort["listOpenIssues"]>> }>();
  const issuesInflight = new Map<string, Promise<Awaited<ReturnType<ScmPort["listOpenIssues"]>>>>();
  const prsCache = new Map<string, { at: number; prs: Awaited<ReturnType<ScmPort["listPrs"]>> }>();
  const prsInflight = new Map<string, Promise<Awaited<ReturnType<ScmPort["listPrs"]>>>>();

  // Listing leases asks the remote, so the Settings page shares one answer for 15 s.
  let leasesCache: { at: number; value: Awaited<ReturnType<DashboardProject["leases"]>> | Error } | null = null;
  async function heldLeases(p: DashboardProject) {
    if (leasesCache && Date.now() - leasesCache.at < 15_000) return leasesCache.value;
    const value = await p.leases().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
    leasesCache = { at: Date.now(), value };
    return value;
  }

  // The Agents page shows each configured agent's installed version and doctor rows.
  // Probing spawns `--version`, so it is cached for a minute and shared by concurrent requests.
  let agentsCache: { at: number; rows: unknown[] } | null = null;
  let agentsInflight: Promise<unknown[]> | null = null;
  async function probedAgents(): Promise<unknown[]> {
    if (agentsCache && Date.now() - agentsCache.at < 60_000) return agentsCache.rows;
    agentsInflight ??= Promise.all(
      agentCatalog(fleet.agents, fleet.stages).map(async (a) => {
        const row = { ...a, name: plain(a.name), binary: plain(a.binary) };
        if (!a.configured) return { ...row, installed: null, version: null, checks: [] };
        const checks = await agentChecks(a.name, fleet.agents, probes);
        const installed = await probes.which(a.binary);
        const version = installed ? ((await probes.versionOf(a.binary)) ?? "").split("\n")[0]!.trim() || null : null;
        return {
          ...row,
          installed,
          version: version === null ? null : plain(version),
          checks: checks.map((c) => ({
            name: plain(c.name),
            ok: c.ok,
            warn: c.warn === true,
            detail: plain(c.detail),
          })),
        };
      }),
    )
      .then((rows) => {
        agentsCache = { at: Date.now(), rows };
        return rows;
      })
      .finally(() => {
        agentsInflight = null;
      });
    return agentsInflight;
  }

  // Single-flight + 10s cache in front of `gh issue list` (plan: "cached gh
  // listing, single-flight, 10s") so a browser polling every few seconds,
  // times any number of open tabs, doesn't turn into one `gh` call per poll.
  // Keyed per repo so the multi-repo inbox (v2.9.0 item 2) never lets one
  // repo's cache serve another's issues.
  async function cachedIssuesFor(r: string) {
    const now = Date.now();
    const cached = issuesCache.get(r);
    if (cached && now - cached.at < BOARD_CACHE_MS) return cached.issues;
    const inflight = issuesInflight.get(r);
    if (inflight) return inflight;
    const promise = github
      .listOpenIssues(r)
      .then((issues) => {
        issuesCache.set(r, { at: Date.now(), issues });
        issuesInflight.delete(r);
        return issues;
      })
      .catch((err) => {
        issuesInflight.delete(r);
        throw err;
      });
    issuesInflight.set(r, promise);
    return promise;
  }

  function invalidateIssuesCache(r: string): void {
    issuesCache.delete(r);
  }

  // Same single-flight + cache pattern as cachedIssuesFor, for the inbox's
  // learning-PR items (plan v2.10.0 item 4), which come from `gh pr list`,
  // not issues.
  async function cachedPrsFor(r: string) {
    const now = Date.now();
    const cached = prsCache.get(r);
    if (cached && now - cached.at < BOARD_CACHE_MS) return cached.prs;
    const inflight = prsInflight.get(r);
    if (inflight) return inflight;
    const promise = github
      .listPrs(r, { state: "open" })
      .then((prs) => {
        prsCache.set(r, { at: Date.now(), prs });
        prsInflight.delete(r);
        return prs;
      })
      .catch((err) => {
        prsInflight.delete(r);
        throw err;
      });
    prsInflight.set(r, promise);
    return promise;
  }

  async function cachedIssues() {
    return cachedIssuesFor(repo);
  }

  // Every repo the multi-repo inbox reads from (v2.9.0 item 2): an explicit
  // FACTORY_REPOS list, else the single configured repo, else whatever repos
  // have ever run under FACTORY_HOME.
  function inboxRepos(): string[] {
    const fromEnv = (process.env.FACTORY_REPOS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (fromEnv.length > 0) return fromEnv;
    return repo ? [repo] : discoverRepos();
  }

  // The primary configured repo's workspaces dir is the injectable
  // `workspaces` param (tests point it at a scratch dir); any other repo in a
  // multi-repo inbox resolves its own workspaces dir under FACTORY_HOME.
  function workspacesFor(r: string): string {
    return r === repo ? workspaces : workspacesDir(process.env, r);
  }

  function json(data: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(data), {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  }

  // Each repo keeps its own state DB; the Line reads every repo the inbox does, and a
  // repo that never ran has no DB to open.
  const otherStates = new Map<string, FactoryState>();
  function stateFor(r: string): FactoryState | null {
    if (r === repo) return state;
    const path = defaultStatePath(process.env, r);
    if (!otherStates.has(r) && existsSync(path)) otherStates.set(r, new FactoryState(path));
    return otherStates.get(r) ?? null;
  }

  // Every stage attempt for a repo, paged by keyset so a long history is never one giant read.
  function allStageRuns(st: FactoryState = state, r: string = repo): ReturnType<FactoryState["listStageRuns"]> {
    const out: ReturnType<FactoryState["listStageRuns"]> = [];
    for (let after = 0; ; ) {
      const page = st.listStageRuns(r, { after, limit: 500 });
      out.push(...page.map(plainStage));
      if (page.length < 500) return out;
      after = page[page.length - 1]!.id;
    }
  }

  const needRepo = (): Response | null => (repo ? null : json({ error: "FACTORY_REPO not set" }, { status: 500 }));

  async function inboxItem(r: string, number: number) {
    return buildInbox(await cachedIssuesFor(r)).find((i) => i.issue === number);
  }

  // Files a stage left in .factory/runs/issue-N/ of the issue's worktree. The
  // name must be a plain file name that resolves inside that directory, and it
  // is only ever sent as text, never as HTML.
  function artifactRoot(issue: number): string | null {
    try {
      return realpathSync(join(workspaces, `issue-${issue}`, runDir(issue)));
    } catch {
      return null;
    }
  }

  function artifacts(issue: number, url: URL): Response {
    const root = artifactRoot(issue);
    const name = url.searchParams.get("file");
    if (!root) return json({ files: [] });
    if (!name) {
      const files = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, size: statSync(join(root, e.name)).size }));
      return json({ files });
    }
    let path: string;
    try {
      path = realpathSync(join(root, name));
    } catch {
      return json({ error: "no such artifact" }, { status: 404 });
    }
    if (name.includes("/") || name.includes("\\") || !path.startsWith(root + sep) || !statSync(path).isFile()) {
      return json({ error: "no such artifact" }, { status: 404 });
    }
    const bytes = readFileSync(path);
    const truncated = bytes.length > ARTIFACT_LIMIT;
    const body = bytes.subarray(0, ARTIFACT_LIMIT);
    const headers: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "x-artifact-truncated": String(truncated),
    };
    if (url.searchParams.get("download"))
      headers["content-disposition"] = `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`;
    // A preview is text for a person; a download stays byte for byte.
    return new Response(url.searchParams.get("download") ? body : plain(Buffer.from(body).toString("utf8")), {
      headers,
    });
  }

  type Handler = (req: Request, url: URL, m: RegExpMatchArray) => Response | Promise<Response>;
  interface Route {
    readonly method: "GET" | "POST";
    readonly pattern: RegExp;
    readonly label: string;
    readonly handler: Handler;
  }

  // The routing table is the only place a route exists, so the route-walk test
  // (tests/dashboard-routes.test.ts) sees every one of them.
  const routes: readonly Route[] = [
    {
      method: "GET",
      pattern: /^\/(index\.html)?$/,
      label: "GET /",
      handler: () => new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
    {
      // Static files of the page itself: no data, so public like the shell.
      method: "GET",
      pattern: /^\/(styles\.css|tokens\.css|app\.js|lib\/[\w-]+\.js|fonts\/[\w-]+\.woff2)$/,
      label: "GET /assets",
      handler: (_req, _url, m) => {
        try {
          const bytes = readFileSync(join(here, "public", m[1]!));
          return new Response(bytes, {
            headers: { "content-type": ASSET_TYPES[m[1]!.split(".").pop()!]!, "cache-control": "no-cache" },
          });
        } catch {
          return json({ error: "not found" }, { status: 404 });
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/session$/,
      label: "POST /api/session",
      // Trade the token for an HttpOnly cookie so a browser never puts it in a URL.
      handler: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { token?: string };
        if (!DASHBOARD_TOKEN || typeof body.token !== "string" || !tokenMatches(body.token, DASHBOARD_TOKEN)) {
          return json({ error: "unauthorized" }, { status: 401 });
        }
        // The cookie is a random id, never the token, so a leaked cookie cannot be replayed as a Bearer token.
        const id = randomBytes(32).toString("hex");
        const now = Date.now();
        for (const [k, expires] of sessions) if (expires <= now) sessions.delete(k);
        if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
        sessions.set(id, now + SESSION_TTL_MS);
        // Behind a TLS-terminating proxy the request arrives as http, so X-Forwarded-Proto counts too.
        const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
        const secure = https ? "; Secure" : "";
        return json(
          { ok: true },
          {
            headers: {
              "set-cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
            },
          },
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/webhook\/github$/,
      label: WEBHOOK_ROUTE,
      handler: async (req) => {
        const secret = webhookSecret();
        if (!secret) return json({ error: "not found" }, { status: 404 });
        if (Number(req.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES)
          return json({ error: "too large" }, { status: 413 });
        const body = await readCapped(req.body, WEBHOOK_MAX_BYTES);
        if (!body) return json({ error: "too large" }, { status: 413 });
        if (!signatureMatches(secret, body, req.headers.get("x-hub-signature-256")))
          return json({ error: "bad signature" }, { status: 401 });
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
          return json({ error: "body is not JSON" }, { status: 400 });
        }
        const d = readDelivery(req.headers, payload);
        if (!d) return json({ error: "missing X-GitHub-Delivery or X-GitHub-Event" }, { status: 400 });
        if (d.event === "ping") return json({ ok: true, pong: true });
        if (!WAKING_EVENTS.has(d.event) || (repo && d.repo.toLowerCase() !== repo.toLowerCase()))
          return json({ ok: true, ignored: true }, { status: 202 });
        const fresh = state.recordDelivery(d);
        return json({ ok: true, recorded: fresh }, { status: fresh ? 201 : 200 });
      },
    },
    {
      method: "POST",
      pattern: /^\/events$/,
      label: EVENTS_ROUTE,
      handler: async (req) => {
        const secret = eventsSecret();
        if (!secret) return json({ error: "not found" }, { status: 404 });
        if (Number(req.headers.get("content-length") ?? 0) > WEBHOOK_MAX_BYTES)
          return json({ error: "too large" }, { status: 413 });
        const bytes = await readCapped(req.body, WEBHOOK_MAX_BYTES);
        if (!bytes) return json({ error: "too large" }, { status: 413 });
        const body = new TextDecoder().decode(bytes);
        if (!verifyEvent(secret, body, req.headers.get(EVENT_SIGNATURE_HEADER)))
          return json({ error: "bad signature" }, { status: 401 });
        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          return json({ error: "body is not JSON" }, { status: 400 });
        }
        const parsed = parseEvent(raw);
        if (!parsed.ok) return json({ error: parsed.problem }, { status: 400 });
        const e = parsed.event;
        if (!isExternalEventType(e.type)) return json({ ok: true, ignored: true }, { status: 202 });
        // Deduped on id: a sender's retry of an event already stored is acknowledged, not re-run.
        const fresh = state.recordBusEvent({
          id: e.id,
          direction: "in",
          type: e.type,
          source: e.source,
          subject: e.subject ?? null,
          time: e.time,
          data: JSON.stringify(e.data),
          handled_at: null,
        });
        return json({ ok: true, recorded: fresh }, { status: fresh ? 201 : 200 });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      label: "GET /api/runs",
      handler: () => json({ repo, runs: state.listRuns(repo || undefined).map(plainRun) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/board$/,
      label: "GET /api/board",
      handler: async () => needRepo() ?? json({ repo, cards: buildBoard(await cachedIssues()) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/mark-ready$/,
      label: "POST /api/mark-ready",
      handler: async (req) => {
        const body = (await req.json()) as { issue?: number };
        const missing = needRepo();
        if (missing) return missing;
        if (!Number.isInteger(body.issue)) return json({ error: "issue must be an integer" }, { status: 400 });
        await github.addLabels(repo, body.issue!, [LABEL.ready]);
        invalidateIssuesCache(repo); // next /api/board reflects the label immediately
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/thread$/,
      label: "GET /api/issues/:n/thread",
      handler: async (_req, url, m) => {
        const r = url.searchParams.get("repo") || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        return json({ issue: plainIssue(await github.getIssue(r, Number(m[1]))) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/artifacts$/,
      label: "GET /api/issues/:n/artifacts",
      handler: (_req, url, m) => artifacts(Number(m[1]), url),
    },
    {
      // The PR review view (v2.9.0 item 1): diff, gate evidence, verify
      // findings, CI status and per-stage cost/model, all in one call so the
      // dashboard never has to go to GitHub itself.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/review$/,
      label: "GET /api/issues/:n/review",
      handler: async (_req, url, m) => {
        const r = url.searchParams.get("repo") || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        const issueNumber = Number(m[1]);
        const pr = await github.prForIssue(r, issueNumber);
        if (!pr) return json({ error: "no open PR closes that issue" }, { status: 404 });
        const cwd = join(workspacesFor(r), `issue-${issueNumber}`);
        const [diff, ci, gate, verify] = await Promise.all([
          github.prDiff(r, pr.number),
          ciStatusNow(github, r, pr.number),
          readGateEvidence(cwd, issueNumber),
          readStageArtifacts(cwd, issueNumber, "verify"),
        ]);
        const stages = state.listStageRuns(r, { issue: issueNumber }).map(plainStage);
        return json({
          repo: r,
          issue: issueNumber,
          pr: { number: pr.number, url: pr.url },
          diff: plain(diff),
          ci,
          gate,
          verify: verify.json ?? null,
          stages,
        });
      },
    },
    {
      // The dashboard's "Approve and merge" action: the same readiness gate
      // and merge primitive as the automated policy, invoked as the operator
      // (decideOperatorMerge, src/merge-policy.ts).
      method: "POST",
      pattern: /^\/api\/issues\/(\d+)\/merge$/,
      label: "POST /api/issues/:n/merge",
      handler: async (req, _url, m) => {
        const body = (await req.json().catch(() => ({}))) as { repo?: string };
        const r = body.repo || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        const issueNumber = Number(m[1]);
        const pr = await github.prForIssue(r, issueNumber);
        if (!pr) return json({ error: "no open PR closes that issue" }, { status: 404 });
        const [readiness, ci] = await Promise.all([
          github.mergeReadiness(r, pr.number),
          ciStatusNow(github, r, pr.number),
        ]);
        const decision = decideOperatorMerge(readiness, ci);
        const merged = await attemptMerge(github, r, pr.number, decision);
        await github.commentIssue(r, issueNumber, renderOperatorAuditComment(decision));
        // The dashboard has no Executor to run retro itself (plan v2.10.0 item
        // 3); queueRetro just records the row, and watch.ts's poll loop
        // (runQueuedRetros) drains it on its next tick.
        if (merged) {
          invalidateIssuesCache(r);
          state.queueRetro(r, issueNumber, "merged");
        }
        return json({ ok: merged, decision });
      },
    },
    {
      // The run page: the agent's activity as cards, read from the stream `factory view` reads.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/live$/,
      label: "GET /api/issues/:n/live",
      handler: (_req, url, m) => {
        const r = url.searchParams.get("repo") || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        return json(
          liveItems(
            streamPath(transcriptPath(r, Number(m[1]), process.env)),
            Number(url.searchParams.get("from") ?? "0") || 0,
          ),
        );
      },
    },
    {
      // The proof a reviewer reads: criteria from the approved plan, the gate, the holdout tests and the revert.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/proof$/,
      label: "GET /api/issues/:n/proof",
      handler: async (_req, url, m) => {
        const r = url.searchParams.get("repo") || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        const n = Number(m[1]);
        const cwd = join(workspacesFor(r), `issue-${n}`);
        const [plan, verify, gate] = await Promise.all([
          readStageArtifacts(cwd, n, "plan"),
          readStageArtifacts(cwd, n, "verify"),
          readGateEvidence(cwd, n),
        ]);
        const [proof, holdout] = await Promise.all(
          ["proof.json", "holdout.json"].map((f) =>
            Bun.file(join(cwd, runDir(n), f))
              .json()
              .catch(() => undefined),
          ),
        );
        return json(
          proofView({ planComment: plan.comment, verdict: verify.json, gateLine: gate?.line, proof, holdout }),
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(\d+)\/events$/,
      label: "GET /api/runs/:id/events",
      handler: (_req, url, m) => {
        const events = state.listEvents(Number(m[1]), { after: Number(url.searchParams.get("after") ?? "0") });
        return json({ events: events.map((e) => ({ ...e, text: plain(e.text) })) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(\d+)\/stages$/,
      label: "GET /api/runs/:id/stages",
      handler: (_req, _url, m) => {
        const run = state.listRuns(repo || undefined).find((r) => r.id === Number(m[1]));
        if (!run) return json({ error: "no such run" }, { status: 404 });
        return json({
          run: plainRun(run),
          stages: state.listStageRuns(run.repo, { issue: run.issue }).map(plainStage),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/line$/,
      label: "GET /api/line",
      // Each recent run with the stages it went through, across every repo the inbox reads.
      handler: () => {
        const repos = repo ? [...new Set([repo, ...inboxRepos()])] : [];
        const rows = repos.flatMap((r) => {
          const st = stateFor(r);
          if (!st) return [];
          const attempts = allStageRuns(st, r);
          return st.listRuns(r).map((run) => ({
            repo: r,
            run: plainRun(run),
            stages: attempts
              .filter((a) => a.issue === run.issue)
              .map((a) => ({
                stage: a.stage,
                agent: a.agent,
                duration_ms: a.duration_ms,
                cost_usd: a.cost_usd,
                ok: a.exit_code === 0 && !a.killed_reason && (a.verdict ?? "pass") === "pass",
              })),
          }));
        });
        rows.sort((a, b) => b.run.started_at.localeCompare(a.run.started_at));
        return json({ repo, repos, rows: rows.slice(0, 100) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/analytics$/,
      label: "GET /api/analytics",
      handler: () =>
        json(
          analytics(state.listRuns(repo || undefined), repo ? allStageRuns() : [], new Date(), (agent) => {
            const a = project?.config.agents[agent];
            return a?.models?.large ?? a?.model;
          }),
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/agents$/,
      label: "GET /api/agents",
      handler: async () => json({ agents: await probedAgents() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/workflows$/,
      label: "GET /api/workflows",
      handler: async () =>
        project
          ? json({ available: true, ...workflowsView(await harnessReport(project.cloneDir, project.config)) })
          : json({ available: false, reason: NO_PROJECT }),
    },
    {
      method: "GET",
      pattern: /^\/api\/settings$/,
      label: "GET /api/settings",
      handler: async () => {
        if (!project) return json({ available: false, reason: NO_PROJECT });
        const [report, leases] = await Promise.all([
          harnessReport(project.cloneDir, project.config),
          heldLeases(project),
        ]);
        return json({ available: true, ...settingsView(project, report, leases, Date.now()) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/inbox$/,
      label: "GET /api/inbox",
      // Aggregated across every repo under FACTORY_HOME (v2.9.0 item 2), or
      // narrowed to one with ?repo=. Each item carries its own repo so the
      // frontend can render and act on a mixed list.
      handler: async (_req, url) => {
        const filter = url.searchParams.get("repo");
        const repos = filter ? [filter] : inboxRepos();
        if (repos.length === 0) return json({ error: "no repo configured or discovered" }, { status: 500 });
        const perRepo = await Promise.all(
          repos.map(async (r) => [
            // Park reasons live in this dashboard's own DB, so only its repo has them.
            ...buildInbox(await cachedIssuesFor(r), r === repo ? parkReasons(state.listRuns(repo)) : undefined).map(
              (i) => ({ ...i, repo: r }),
            ),
            ...learningPrItems(await cachedPrsFor(r)).map((i) => ({ ...i, repo: r })),
          ]),
        );
        const items = perRepo
          .flat()
          .sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? "") || a.issue - b.issue);
        return json({ repos: inboxRepos(), repo, items });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/inbox\/(\d+)\/act$/,
      label: "POST /api/inbox/:n/act",
      handler: async (req, _url, m) => {
        const body = (await req.json()) as { action?: InboxAction; text?: string; repo?: string };
        const r = body.repo || repo;
        if (!r) return json({ error: "no repo configured or specified" }, { status: 400 });
        const item = await inboxItem(r, Number(m[1]));
        if (!item) return json({ error: "nothing is waiting on that issue" }, { status: 404 });
        try {
          const posted = await act(github, r, item, body.action as InboxAction, body.text ?? "");
          invalidateIssuesCache(r);
          return json({ ok: true, posted });
        } catch (err) {
          if (err instanceof InboxError) return json({ error: err.message }, { status: 400 });
          throw err;
        }
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/toggles$/,
      label: "GET /api/toggles",
      handler: () =>
        json({
          auto_start: state.getToggle("auto_start", true),
          auto_approve_low_risk: state.getToggle("auto_approve_low_risk", autoApproveDefault),
        }),
    },
    {
      method: "POST",
      pattern: /^\/api\/toggles$/,
      label: "POST /api/toggles",
      handler: async (req) => {
        const body = (await req.json()) as { key: string; value: boolean };
        if (body.key !== "auto_start" && body.key !== "auto_approve_low_risk")
          return json({ error: "unknown toggle" }, { status: 400 });
        state.setToggle(body.key, Boolean(body.value));
        return json({ ok: true });
      },
    },
    // Reply box and the action buttons post the same text a human would type in
    // the issue thread, so untrusted-input handling stays in one place (watch.ts).
    {
      method: "POST",
      pattern: /^\/api\/reply$/,
      label: "POST /api/reply",
      handler: async (req) => {
        const body = (await req.json()) as { issue: number; text: string };
        const missing = needRepo();
        if (missing) return missing;
        await github.commentIssue(repo, body.issue, body.text);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/command$/,
      label: "POST /api/command",
      handler: async (req) => {
        const body = (await req.json()) as {
          issue: number;
          command: "approve" | "revise" | "retry" | "cancel";
          text?: string;
        };
        const missing = needRepo();
        if (missing) return missing;
        const text = body.command === "revise" ? `/factory revise ${body.text ?? ""}` : `/factory ${body.command}`;
        // Round-trip through parseChatOps so a malformed command from the UI
        // fails the same way an equivalent typed comment would.
        if (parseChatOps(text).type === "answer")
          return json({ error: "not a recognized /factory command" }, { status: 400 });
        await github.commentIssue(repo, body.issue, text);
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/stream$/,
      label: "GET /api/stream",
      handler: (req) => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = () => {
              const payload = JSON.stringify({ repo, runs: state.listRuns(repo || undefined) });
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            };
            send();
            const timer = setInterval(send, 2000);
            req.signal.addEventListener("abort", () => {
              clearInterval(timer);
              controller.close();
            });
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      },
    },
  ];

  function authorized(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    if (header.startsWith("Bearer ")) return tokenMatches(header.slice(7), DASHBOARD_TOKEN);
    const expires = sessions.get(cookie(req, SESSION_COOKIE));
    return expires !== undefined && expires > Date.now();
  }

  // `remoteAddress` comes from `server.requestIP(req)` at the real Bun.serve
  // call site; undefined (unknown) is treated as NOT loopback: fail closed,
  // the same rule as guard-paths.sh.
  async function handle(req: Request, remoteAddress?: string): Promise<Response> {
    const url = new URL(req.url);
    const loopback = isLoopback(remoteAddress);
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    const isPublic = route !== undefined && PUBLIC_ROUTES.includes(route.label);

    // The webhook carries its own HMAC, so GitHub may reach it with no dashboard token set.
    const signedWebhook =
      (route?.label === WEBHOOK_ROUTE && webhookSecret() !== "") ||
      (route?.label === EVENTS_ROUTE && eventsSecret() !== "");
    if (!loopback && !DASHBOARD_TOKEN && !signedWebhook) {
      return json(
        { error: "refused: reachable from a non-loopback address with no FACTORY_DASHBOARD_TOKEN set" },
        { status: 503 },
      );
    }
    // Token, when set, guards every non-public route for every caller, so an
    // unknown path is refused before it can 404 (no route probing).
    if (DASHBOARD_TOKEN && !isPublic && !authorized(req)) return json({ error: "unauthorized" }, { status: 401 });

    // CSRF: a mutating request must be same-origin JSON, never the
    // `text/plain` a plain HTML form can send cross-site without a preflight.
    if (req.method === "POST") {
      const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
      const cloudEvent = route?.label === EVENTS_ROUTE && contentType.startsWith("application/cloudevents+json");
      if (!contentType.startsWith("application/json") && !cloudEvent)
        return json({ error: "expected application/json" }, { status: 415 });
      const origin = req.headers.get("origin");
      if (origin) {
        let originHost: string;
        try {
          originHost = new URL(origin).host;
        } catch {
          return json({ error: "invalid Origin header" }, { status: 403 });
        }
        if (originHost !== url.host) return json({ error: "cross-origin request rejected" }, { status: 403 });
      }
    }

    if (!route) return json({ error: "not found" }, { status: 404 });
    return route.handler(req, url, url.pathname.match(route.pattern)!);
  }

  const routeLabels = routes.map((r) => r.label);

  return { handle, routeLabels };
}

if (import.meta.main) {
  const state = new FactoryState(DB_PATH);
  // No config file here, so the default tracker; `factory dashboard --repo-dir` reads the repo's.
  const github = makeScm(DEFAULT_CONFIG);
  const dashboard = createDashboard(state, github, REPO);
  // 127.0.0.1 by default (audit finding #16): reach it over the network only
  // by explicitly setting FACTORY_DASHBOARD_HOST=0.0.0.0 (the Docker image
  // does this and relies on FACTORY_DASHBOARD_TOKEN instead) or an SSH
  // tunnel, never by accident.
  const hostname = process.env.FACTORY_DASHBOARD_HOST ?? "127.0.0.1";
  const server = Bun.serve({
    port: PORT,
    hostname,
    fetch: (req: Request): Promise<Response> => dashboard.handle(req, server.requestIP(req)?.address),
  });
  console.log(`factory dashboard: http://${hostname}:${PORT} (repo=${REPO || "unset"})`);
}
