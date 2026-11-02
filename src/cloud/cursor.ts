// Unconfirmed against the live API and to be checked before enabling: model ids (confirm with GET
// /v1/models), concurrency and rate limits per key, reach into private repos, and whether
// workOnCurrentBranch pushes to startingRef.

import { createHash } from "node:crypto";
import type { SecretsPort } from "../ports/secrets";
import { CloudError, type CloudProvider, type CloudRun, type CloudStatus, type LaunchInput } from "./port";

export function agentIdFor(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `bc-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function safeMessage(prefix: string, body: string): string {
  const trimmed = body.length > 200 ? `${body.slice(0, 200)}...` : body;
  return trimmed ? `${prefix}: ${trimmed}` : prefix;
}

function mapStatus(raw: string): CloudStatus {
  switch (raw) {
    case "CREATING":
      return "creating";
    case "RUNNING":
    case "WAITING_FOR_BACKGROUND_WORK":
      return "running";
    case "FINISHED":
      return "finished";
    case "ERROR":
      return "error";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      return "running";
  }
}

function runFromAgent(id: string, body: Record<string, unknown>): CloudRun {
  const status = mapStatus(String(body.status ?? ""));
  let prUrl: string | undefined;
  const git = body.git as { branches?: { prUrl?: string }[] } | undefined;
  if (git?.branches) {
    for (const b of git.branches) {
      if (b.prUrl) {
        prUrl = b.prUrl;
        break;
      }
    }
  }
  const summary = typeof body.summary === "string" ? body.summary : undefined;
  return { id, status, prUrl, summary };
}

async function readKey(secrets: SecretsPort, keyEnv: string): Promise<string> {
  const key = secrets.get(keyEnv);
  if (!key) throw new CloudError("auth", `the cursor-cloud key is not set (${keyEnv})`);
  return key;
}

export function cursorProvider(opts: {
  secrets: SecretsPort;
  keyEnv: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
  autoCreatePr?: boolean;
}): CloudProvider {
  const base = (opts.baseUrl ?? "https://api.cursor.com").replace(/\/$/, "");
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function request(method: string, path: string, body?: unknown, retried = 0): Promise<Response> {
    const key = await readKey(opts.secrets, opts.keyEnv);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && retried < 3) {
      const ra = res.headers.get("Retry-After");
      let waitMs = 2000 * 2 ** retried;
      if (ra) {
        const sec = Number(ra);
        if (!Number.isNaN(sec)) waitMs = Math.min(sec * 1000, 60_000);
      }
      await sleep(waitMs);
      return request(method, path, body, retried + 1);
    }
    return res;
  }

  async function fail(res: Response, kind: CloudError["kind"], prefix: string): Promise<never> {
    const text = await res.text();
    throw new CloudError(kind, safeMessage(prefix, text));
  }

  const provider: CloudProvider = {
    name: "cursor-cloud",

    async launch(i: LaunchInput): Promise<CloudRun> {
      const agentId = agentIdFor(i.key);
      const payload = {
        prompt: { text: i.prompt },
        repos: [{ url: i.repoUrl, startingRef: i.branch }],
        workOnCurrentBranch: true,
        autoCreatePR: opts.autoCreatePr ?? false,
        skipReviewerRequest: true,
        model: { id: i.model },
        name: i.title,
        agentId,
      };
      const res = await request("POST", "/v1/agents", payload);
      if (res.status === 409) {
        const text = await res.text();
        if (text.includes("existing") || text.includes(agentId)) {
          return provider.poll(agentId);
        }
        throw new CloudError("busy", safeMessage("agent busy", text));
      }
      if (res.status === 401 || res.status === 403) await fail(res, "auth", "cursor auth failed");
      if (res.status === 404) await fail(res, "not_found", "cursor not found");
      if (res.status === 429) await fail(res, "rate_limited", "cursor rate limited");
      if (!res.ok) await fail(res, "provider", "cursor launch failed");
      const json = (await res.json()) as Record<string, unknown>;
      const id = String(json.id ?? agentId);
      return runFromAgent(id, json);
    },

    async poll(id: string): Promise<CloudRun> {
      const res = await request("GET", `/v1/agents/${encodeURIComponent(id)}`);
      if (res.status === 401 || res.status === 403) await fail(res, "auth", "cursor auth failed");
      if (res.status === 404) await fail(res, "not_found", "cursor not found");
      if (res.status === 429) await fail(res, "rate_limited", "cursor rate limited");
      if (!res.ok) await fail(res, "provider", "cursor poll failed");
      const json = (await res.json()) as Record<string, unknown>;
      return runFromAgent(id, json);
    },

    async usage(id: string): Promise<{ costUsd?: number }> {
      const res = await request("GET", `/v1/agents/${encodeURIComponent(id)}/usage`);
      if (res.status === 401 || res.status === 403) await fail(res, "auth", "cursor auth failed");
      if (res.status === 404) await fail(res, "not_found", "cursor not found");
      if (res.status === 429) await fail(res, "rate_limited", "cursor rate limited");
      if (!res.ok) await fail(res, "provider", "cursor usage failed");
      const json = (await res.json()) as Record<string, unknown>;
      const cost = json.cost ?? json.costUsd ?? json.totalCostUsd;
      if (typeof cost === "number" && !Number.isNaN(cost)) return { costUsd: cost };
      return {};
    },

    async steer(id: string, text: string): Promise<void> {
      const res = await request("POST", `/v1/agents/${encodeURIComponent(id)}/runs`, {
        prompt: { text },
      });
      if (res.status === 401 || res.status === 403) await fail(res, "auth", "cursor auth failed");
      if (res.status === 404) await fail(res, "not_found", "cursor not found");
      if (res.status === 409) await fail(res, "busy", "agent busy");
      if (res.status === 429) await fail(res, "rate_limited", "cursor rate limited");
      if (!res.ok) await fail(res, "provider", "cursor steer failed");
    },

    async cancel(id: string): Promise<void> {
      const res = await request("POST", `/v1/agents/${encodeURIComponent(id)}/cancel`);
      if (res.status === 401 || res.status === 403) await fail(res, "auth", "cursor auth failed");
      if (res.status === 404) await fail(res, "not_found", "cursor not found");
      if (res.status === 429) await fail(res, "rate_limited", "cursor rate limited");
      if (!res.ok) await fail(res, "provider", "cursor cancel failed");
    },
  };
  return provider;
}
