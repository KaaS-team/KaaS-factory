// The cockpit (plan section 2): one static page, a JSON API and SSE, read from what watch.ts wrote;
// replies go out through github.ts as the signed-in `gh` user. /api/board alone reads GitHub labels
// (dashboard/board.ts), so the board works on a CI or VM run with no local SQLite at all.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScmPort } from "../src/github";
import { makeScm } from "../src/scm";
import { GitHub } from "../src/github";
import { appFromEnv, feedInstalledRepos, ghRunner } from "../src/github-app";
import { FactoryState, DEFAULT_DB_PATH } from "../src/state";
import { buildBoard } from "./board";
import { paneRoutes } from "./pane";
import { LABEL } from "../src/labels";
import { InboxError, act, inboxWithRisk, parkReasons, type InboxAction } from "../src/inbox";
import { prItems } from "../src/stale-pr";
import { plain } from "../src/display";
import { versionOf, which } from "../src/probes";
import { DEFAULT_CONFIG, eventsInboundSecretEnv, type FactoryConfig } from "../src/config";
import { defaultStatePath, factoryHome, servedRepos, streamPath, transcriptPath, workspacesDir } from "../src/paths";
import { defaultRepo } from "../src/paths";
import { liveItems, proofView } from "./run-page";
import { runDir, readGateEvidence, readStageArtifacts } from "../src/artifacts";
import { ciStatusNow } from "../src/ci";
import { attemptMerge, decideOperatorMerge, renderOperatorAuditComment } from "../src/merge-policy";
import { codeownersFromBase, rulesFor } from "../src/profile-rules";
import { analytics } from "./analytics";
import { HEALTH_ROUTE, healthRoute } from "./health";
import { agentsProbe, type DashboardProject, projectResolver } from "./project";
import { workflowRoutes } from "./workflow-routes";
import { artifacts } from "./artifacts";
import { createAccess, type Route } from "./plane/access";
import { planeExtensions } from "./plane/extension";
import { boardCache } from "./plane/board-cache";
import { readAccess, runIn } from "./plane/repo-scope";
import { PlaneStore } from "./plane/store";
import { senderName } from "./plane/commands";
import { planeRoutes } from "./plane/mode";
import { createRemote, REMOTE_PUBLIC_ROUTES } from "./plane/remote";
import {
  readCapped,
  readDelivery,
  signatureMatches,
  WAKING_EVENTS,
  WEBHOOK_MAX_BYTES,
  WEBHOOK_SECRET_ENV,
} from "../src/webhook";
import { EVENT_SIGNATURE_HEADER, isExternalEventType, parseEvent, verifyEvent } from "../src/core/event";
import { INTEGRATION_PUBLIC_ROUTES, integrationRoutes, type Secrets } from "./plane/integrations";

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
const REPO = defaultRepo();
// Audit finding #16: bound to 127.0.0.1 by default, and a non-loopback caller is refused unless this
// is set. Module scope, so createDashboard and the CLI's dashboard both read it from the process env.
const DASHBOARD_TOKEN = process.env.FACTORY_DASHBOARD_TOKEN ?? "";

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

// The only routes reachable without a token. Everything else is default-deny;
// tests/dashboard-routes.test.ts walks every route against this list.
export const PUBLIC_ROUTES: readonly string[] = [
  "GET /",
  "GET /assets",
  "POST /api/session",
  "GET /auth/github",
  "GET /auth/github/callback",
  WEBHOOK_ROUTE,
  EVENTS_ROUTE,
  HEALTH_ROUTE,
  ...INTEGRATION_PUBLIC_ROUTES,
  ...REMOTE_PUBLIC_ROUTES,
];

const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
  png: "image/png",
};

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

// One members file per factory home: a plane serves every repo its inbox does.
// With a GitHub App the plane is hosted: it serves the App's repos, and a member sees only those
// GitHub lets them read.
export function servingAccess() {
  const app = appFromEnv();
  const github = new GitHub(ghRunner());
  if (app) feedInstalledRepos(app);
  return createAccess({
    token: DASHBOARD_TOKEN,
    store: new PlaneStore(process.env.FACTORY_PLANE_DB ?? join(factoryHome(), "plane.db")),
    extensions: app ? [...planeExtensions(), readAccess((r, l) => github.roleOf(r, l))] : undefined,
  });
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
  access = createAccess({ token: DASHBOARD_TOKEN }),
) {
  const indexHtml = readFileSync(join(here, "public", "index.html"), "utf8");
  // Read by name on every request; the value is never logged or returned.
  const eventsSecret = () => process.env[eventsInboundSecretEnv(project?.config)] ?? "";
  const integrations = integrationRoutes({ state, tracker: github, repo, project, store: access.store });
  const signed: Secrets = { ...integrations.secrets, [WEBHOOK_ROUTE]: webhookSecret, [EVENTS_ROUTE]: eventsSecret };
  const projectFor = projectResolver(repo, project);
  const agents = agentsProbe(probes);

  // Issue and PR lists go through the gh budget (dashboard/plane/board-cache.ts), keyed per repo.
  const board = boardCache({ rate: github.rateLimit ? (r) => github.rateLimit!(r) : undefined });
  const cachedIssuesFor = (r: string) => board.read("issues", r, () => github.listOpenIssues(r));
  const cachedPrsFor = (r: string) => board.read("prs", r, () => github.listPrs(r, { state: "open" }));
  const invalidateIssuesCache = (r: string) => void board.invalidate(r);

  const inboxRepos = () => servedRepos(process.env, repo);
  const repoOf = access.repoOf;
  // A list with no ?repo= reads every served repo the caller may see; tenancy narrows it.
  const reposFor = (req: Request) => (repoOf(req) ? [repoOf(req)] : access.visibleRepos(req, inboxRepos()));
  // A hosted member who may not read the default repo is never told its name.
  const homeOf = (req: Request) => (repo ? (access.visibleRepos(req, [repo])[0] ?? "") : "");
  const runsOf = (req: Request) =>
    reposFor(req)
      .flatMap((r) => stateFor(r)?.listRuns(r) ?? [])
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  const stagesOf = (req: Request) =>
    reposFor(req).flatMap((r) => {
      const st = stateFor(r);
      return st ? allStageRuns(st, r) : [];
    });

  // The default repo's workspaces dir is the `workspaces` param (tests point it at a scratch dir);
  // any other served repo resolves its own under FACTORY_HOME.
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
  function stateFor(r: string, create = false): FactoryState | null {
    if (r === repo) return state;
    const path = defaultStatePath(process.env, r);
    if (!otherStates.has(r) && (create || existsSync(path))) {
      mkdirSync(dirname(path), { recursive: true });
      otherStates.set(r, new FactoryState(path));
    }
    // A plane with no repo of its own opened the shared pre-v2.6.2 DB, which holds rows for many repos.
    return otherStates.get(r) ?? (repo ? null : state);
  }

  // Every stage attempt for a repo, paged by keyset so a long history is never one giant read.
  function allStageRuns(st: FactoryState, r: string): ReturnType<FactoryState["listStageRuns"]> {
    const out: ReturnType<FactoryState["listStageRuns"]> = [];
    for (let after = 0; ; ) {
      const page = st.listStageRuns(r, { after, limit: 500 });
      out.push(...page.map(plainStage));
      if (page.length < 500) return out;
      after = page[page.length - 1]!.id;
    }
  }

  async function inboxItem(r: string, number: number) {
    return inboxWithRisk(await cachedIssuesFor(r)).find((i) => i.issue === number);
  }

  // Every route lives in this table, so the route walk (tests/dashboard-routes.test.ts) sees each one.
  const remote = createRemote({ access, github, repo, served: inboxRepos, handle: (req) => readInProcess(req) });
  const routes: readonly Route[] = [
    healthRoute,
    {
      method: "GET",
      pattern: /^\/(index\.html)?$/,
      label: "GET /",
      handler: () => new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } }),
    },
    {
      // Static files of the page itself: no data, so public like the shell.
      method: "GET",
      pattern:
        /^\/(styles\.css|tokens\.css|app\.js|sw\.js|manifest\.webmanifest|icon\.svg|apple-touch-icon\.png|lib\/[\w-]+\.js|fonts\/[\w-]+\.woff2)$/,
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
    ...access.routes,
    ...remote.routes,
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
        // GitHub sends the name as the repo spells it; a repo this plane does not serve is ignored.
        const target = inboxRepos().find((r) => r.toLowerCase() === d.repo.toLowerCase());
        if (target) board.heard(target);
        if (!WAKING_EVENTS.has(d.event) || !target) return json({ ok: true, ignored: true }, { status: 202 });
        const fresh = stateFor(target, true)!.recordDelivery(d);
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
      role: "viewer",
      repo: "filter",
      handler: (req) => json({ repo: homeOf(req), runs: runsOf(req).map(plainRun) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/board$/,
      label: "GET /api/board",
      role: "viewer",
      repo: "query",
      handler: async (req) => json({ repo: repoOf(req), cards: buildBoard(await cachedIssuesFor(repoOf(req))) }),
    },
    {
      method: "POST",
      pattern: /^\/api\/mark-ready$/,
      label: "POST /api/mark-ready",
      role: "operator",
      repo: "body",
      handler: async (req) => {
        const body = (await req.json()) as { issue?: number };
        if (!Number.isInteger(body.issue)) return json({ error: "issue must be an integer" }, { status: 400 });
        await github.addLabels(repoOf(req), body.issue!, [LABEL.ready]);
        invalidateIssuesCache(repoOf(req)); // next /api/board reflects the label immediately
        return json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/thread$/,
      label: "GET /api/issues/:n/thread",
      role: "viewer",
      repo: "query",
      handler: async (req, _url, m) => json({ issue: plainIssue(await github.getIssue(repoOf(req), Number(m[1]))) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/artifacts$/,
      label: "GET /api/issues/:n/artifacts",
      role: "viewer",
      repo: "query",
      handler: (req, url, m) => artifacts(workspacesFor(repoOf(req)), Number(m[1]), url),
    },
    {
      // The PR review view (v2.9.0 item 1): diff, gate evidence, verify
      // findings, CI status and per-stage cost/model, all in one call so the
      // dashboard never has to go to GitHub itself.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/review$/,
      label: "GET /api/issues/:n/review",
      role: "viewer",
      repo: "query",
      handler: async (req, _url, m) => {
        const r = repoOf(req);
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
        const stages = (stateFor(r)?.listStageRuns(r, { issue: issueNumber }) ?? []).map(plainStage);
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
      role: "approver",
      repo: "body",
      handler: async (req, _url, m) => {
        const r = repoOf(req);
        const issueNumber = Number(m[1]);
        const pr = await github.prForIssue(r, issueNumber);
        if (!pr) return json({ error: "no open PR closes that issue" }, { status: 404 });
        const [readiness, ci] = await Promise.all([
          github.mergeReadiness(r, pr.number),
          ciStatusNow(github, r, pr.number),
        ]);
        let owners: Parameters<typeof decideOperatorMerge>[2];
        if (rulesFor((await projectFor(r))?.config.profile).codeownerApproval) {
          const files = await github.prFiles?.(r, pr.number).catch(() => undefined);
          owners = {
            rules: await codeownersFromBase(github, r, readiness.baseRefName),
            files,
            approvedBy: readiness.approvedBy ?? [],
          };
        }
        const decision = decideOperatorMerge(readiness, ci, owners);
        const merged = await attemptMerge(github, r, pr.number, decision);
        await github.commentIssue(r, issueNumber, renderOperatorAuditComment(decision));
        // The dashboard has no Executor to run retro itself (plan v2.10.0 item
        // 3); queueRetro just records the row, and watch.ts's poll loop
        // (runQueuedRetros) drains it on its next tick.
        if (merged) {
          invalidateIssuesCache(r);
          stateFor(r, true)!.queueRetro(r, issueNumber, "merged");
        }
        return json({ ok: merged, decision });
      },
    },
    {
      // The run page: the agent's activity as cards, read from the stream `factory view` reads.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/live$/,
      label: "GET /api/issues/:n/live",
      role: "viewer",
      repo: "query",
      handler: (req, url, m) =>
        json(
          liveItems(
            streamPath(transcriptPath(repoOf(req), Number(m[1]), process.env)),
            Number(url.searchParams.get("from") ?? "0") || 0,
          ),
        ),
    },
    {
      // The proof a reviewer reads: criteria from the approved plan, the gate, the holdout tests and the revert.
      method: "GET",
      pattern: /^\/api\/issues\/(\d+)\/proof$/,
      label: "GET /api/issues/:n/proof",
      role: "viewer",
      repo: "query",
      handler: async (req, _url, m) => {
        const n = Number(m[1]);
        const cwd = join(workspacesFor(repoOf(req)), `issue-${n}`);
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
      role: "viewer",
      repo: "query",
      handler: (req, url, m) => {
        const hit = runIn(stateFor(repoOf(req)), repoOf(req), Number(m[1]));
        if (!hit) return json({ error: "no such run" }, { status: 404 });
        const events = hit.st.listEvents(hit.run.id, { after: Number(url.searchParams.get("after") ?? "0") });
        return json({ events: events.map((e) => ({ ...e, text: plain(e.text) })) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/(\d+)\/stages$/,
      label: "GET /api/runs/:id/stages",
      role: "viewer",
      repo: "query",
      handler: (req, _url, m) => {
        const hit = runIn(stateFor(repoOf(req)), repoOf(req), Number(m[1]));
        if (!hit) return json({ error: "no such run" }, { status: 404 });
        const { st, run } = hit;
        return json({
          run: plainRun(run),
          stages: st.listStageRuns(run.repo, { issue: run.issue }).map(plainStage),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/line$/,
      label: "GET /api/line",
      role: "viewer",
      repo: "filter",
      // Each recent run with the stages it went through, across every repo the inbox reads.
      handler: (req) => {
        const repos = reposFor(req);
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
        return json({ repo: homeOf(req), repos, rows: rows.slice(0, 100) });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/analytics$/,
      label: "GET /api/analytics",
      role: "viewer",
      repo: "filter",
      handler: (req) =>
        json(
          analytics(runsOf(req), stagesOf(req), new Date(), (agent) => {
            const a = project?.config.agents[agent];
            return a?.models?.large ?? a?.model;
          }),
        ),
    },
    {
      method: "GET",
      pattern: /^\/api\/agents$/,
      label: "GET /api/agents",
      role: "viewer",
      repo: "query",
      handler: async (req) => json({ agents: await agents(repoOf(req), await projectFor(repoOf(req)), fleet) }),
    },
    // Workflows, Events, Minions and the workflow form: dashboard/workflow-routes.ts.
    ...workflowRoutes({ github, projectFor, stateFor, workspacesFor, access, integrations: integrations.bound }),
    {
      method: "GET",
      pattern: /^\/api\/inbox$/,
      label: "GET /api/inbox",
      role: "viewer",
      repo: "filter",
      // Aggregated across every repo under FACTORY_HOME (v2.9.0 item 2), or
      // narrowed to one with ?repo=. Each item carries its own repo so the
      // frontend can render and act on a mixed list.
      handler: async (req) => {
        const repos = reposFor(req);
        if (repos.length === 0) return json({ error: "no repo configured or discovered" }, { status: 500 });
        const perRepo = await Promise.all(
          repos.map(async (r) => [
            ...inboxWithRisk(await cachedIssuesFor(r), parkReasons(stateFor(r)?.listRuns(r) ?? [])).map((i) => ({
              ...i,
              repo: r,
            })),
            ...prItems(await cachedPrsFor(r)).map((i) => ({ ...i, repo: r, risk: null })),
          ]),
        );
        const items = perRepo
          .flat()
          .sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? "") || a.issue - b.issue);
        return json({ repos: access.visibleRepos(req, inboxRepos()), repo: homeOf(req), items });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/inbox\/(\d+)\/act$/,
      label: "POST /api/inbox/:n/act",
      role: "operator",
      repo: "body",
      handler: async (req, _url, m) => {
        const body = (await req.json()) as { action?: InboxAction; text?: string };
        const r = repoOf(req);
        const item = await inboxItem(r, Number(m[1]));
        if (!item) return json({ error: "nothing is waiting on that issue" }, { status: 404 });
        try {
          const by = senderName(access.actorOf(req));
          const posted = await act(github, r, item, body.action as InboxAction, body.text ?? "", by);
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
      role: "viewer",
      repo: "query",
      handler: (req) => {
        const st = stateFor(repoOf(req));
        return json({
          auto_start: st?.getToggle("auto_start", true) ?? true,
          auto_approve_low_risk: st?.getToggle("auto_approve_low_risk", autoApproveDefault) ?? autoApproveDefault,
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/toggles$/,
      label: "POST /api/toggles",
      role: "owner",
      repo: "body",
      handler: async (req) => {
        const body = (await req.json()) as { key: string; value: boolean };
        if (body.key !== "auto_start" && body.key !== "auto_approve_low_risk")
          return json({ error: "unknown toggle" }, { status: 400 });
        stateFor(repoOf(req), true)!.setToggle(body.key, Boolean(body.value));
        return json({ ok: true });
      },
    },
    // Start, approve, revise, answer, retry and cancel: each one a signed comment on the issue first.
    ...planeRoutes({ github, repoOf, actorOf: access.actorOf, invalidate: invalidateIssuesCache }),
    ...integrations.routes,
    ...paneRoutes({ repoOf, workspacesFor, actorOf: access.actorOf, runs: (r) => stateFor(r) }),
    {
      method: "GET",
      pattern: /^\/api\/stream$/,
      label: "GET /api/stream",
      role: "viewer",
      repo: "filter",
      handler: (req) => {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            const send = () => {
              const payload = JSON.stringify({ repo: homeOf(req), runs: runsOf(req) });
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

  // `remoteAddress` comes from `server.requestIP(req)` at the real Bun.serve
  // call site; undefined (unknown) is treated as NOT loopback: fail closed,
  // the same rule as guard-paths.sh.
  async function handle(req: Request, remoteAddress?: string, inProcess = false): Promise<Response> {
    const url = new URL(req.url);
    const loopback = isLoopback(remoteAddress);
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    const isPublic = route !== undefined && (PUBLIC_ROUTES.includes(route.label) || route.public === true);
    // A webhook carries its own signature, so its sender may reach it with no dashboard token set.
    const signedWebhook = route !== undefined && (signed[route.label]?.() ?? "") !== "";
    if (!loopback && !access.guarded() && !signedWebhook) {
      return json(
        {
          error: "refused: reachable from a non-loopback address with no FACTORY_DASHBOARD_TOKEN or GitHub sign-in set",
        },
        { status: 503 },
      );
    }
    // Every non-public route needs a caller with its role, so an unknown path
    // is refused before it can 404 (no route probing).
    const refused = await access.gate(req, route, isPublic, loopback, inProcess, { served: inboxRepos });
    if (refused) return refused;

    // CSRF: a mutating request must be same-origin JSON, never the
    // `text/plain` a plain HTML form can send cross-site without a preflight.
    if (req.method !== "GET" && !route?.public) {
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
    return access.audited(req, route, async () => route.handler(req, url, url.pathname.match(route.pattern)!));
  }

  const routeLabels = routes.map((r) => r.label);
  const routeRoles = Object.fromEntries(routes.map((r) => [r.label, r.role]));
  const routeScopes = Object.fromEntries(routes.map((r) => [r.label, r.repo ?? null]));

  // Bun.serve passes two arguments, so only code in this process reaches the third.
  const readInProcess = (req: Request) => handle(req, "127.0.0.1", true);

  return { handle, readInProcess, routeLabels, routeRoles, routeScopes, access, remote };
}

if (import.meta.main) {
  const state = new FactoryState(DB_PATH);
  // No config file here, so the default tracker; `factory dashboard --repo-dir` reads the repo's.
  const github = makeScm(DEFAULT_CONFIG);
  const dashboard = createDashboard(
    state,
    github,
    REPO,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    servingAccess(),
  );
  // 127.0.0.1 by default (audit finding #16): off the box only by setting FACTORY_DASHBOARD_HOST=0.0.0.0
  // (docker-compose.yml does, with FACTORY_DASHBOARD_TOKEN) or through an SSH tunnel, never by accident.
  const hostname = process.env.FACTORY_DASHBOARD_HOST ?? "127.0.0.1";
  const server = Bun.serve({
    port: PORT,
    hostname,
    fetch: (req: Request): Promise<Response> => dashboard.handle(req, server.requestIP(req)?.address),
  });
  console.log(`factory dashboard: http://${hostname}:${PORT} (repo=${REPO || "unset"})`);
  dashboard.remote.start();
}
