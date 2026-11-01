// The contract a customer's own bot declares to fill a step: what it fills, how it is reached, what
// it may read and what it costs. validateManifest checks it at load time and never throws.

export const CAPABILITIES = ["checks", "preview", "review", "qa", "summary", "notifications"] as const;
export const TRANSPORTS = ["exec", "http", "mcp", "a2a", "github-check", "webhook"] as const;
export const REQUEST_FIELDS = ["diff", "plan", "criteria", "preview_url", "issue_body", "changed_files"] as const;

// Only FACTORY_EXT_* names may carry a token, so a manifest cannot point at a runner secret.
export const EXT_VAR = /^FACTORY_EXT_\w+$/;

export type Capability = (typeof CAPABILITIES)[number];
export type Transport = (typeof TRANSPORTS)[number];
export type RequestField = (typeof REQUEST_FIELDS)[number];

export interface Manifest {
  apiVersion: "factory.extension/v1";
  name: string;
  fills: { capability: Capability };
  transport: { kind: Transport } & Record<string, unknown>;
  inputs: RequestField[];
  timeoutMs: number;
  retries: number;
  cost: { maxUsd: number };
  blocking: boolean;
  tokenEnv?: string;
  secretEnv?: string;
}

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

const NAME = /^[a-z0-9-]+$/;
const TIMEOUT = /^(\d+)([ms])$/;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const REQUIRED_KEYS: Record<Transport, string[]> = {
  exec: ["command"],
  http: ["url"],
  mcp: ["server", "tool"],
  a2a: ["url"],
  "github-check": ["name", "app"],
  webhook: ["url"],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function urlProblem(field: string, value: unknown): string | undefined {
  if (!isText(value)) return undefined;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return `${field} is not a valid URL.`;
  }
  const secure = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.includes(u.hostname));
  return secure ? undefined : `${field} must be https, or http to localhost, 127.0.0.1 or [::1].`;
}

function transportProblems(raw: unknown, out: string[]): void {
  if (!isObj(raw)) return void out.push("transport must be an object with a kind.");
  const kind = raw.kind as Transport;
  if (!TRANSPORTS.includes(kind)) {
    return void out.push(`transport.kind must be one of ${TRANSPORTS.join(", ")}.`);
  }
  for (const key of REQUIRED_KEYS[kind]) {
    if (!isText(raw[key])) out.push(`transport.${key} is required when transport.kind is ${kind}.`);
  }
  if (kind === "http" || kind === "a2a" || kind === "webhook") {
    const p = urlProblem("transport.url", raw.url);
    if (p) out.push(p);
  }
}

function envProblem(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && EXT_VAR.test(value)) return undefined;
  return `${field} must be a variable named FACTORY_EXT_*, so a manifest cannot name a runner secret.`;
}

export function validateManifest(raw: unknown): ManifestResult {
  const problems: string[] = [];
  if (!isObj(raw)) return { ok: false, problems: ["The manifest must be an object."] };

  if (raw.apiVersion !== "factory.extension/v1") problems.push("apiVersion must be factory.extension/v1.");
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) {
    problems.push("name must use lowercase letters, digits and dashes only.");
  }

  const capability = isObj(raw.fills) ? raw.fills.capability : undefined;
  if (capability === "merge") problems.push("fills.capability cannot be merge: merge stays with the runner.");
  else if (!CAPABILITIES.includes(capability as Capability)) {
    problems.push(`fills.capability must be one of ${CAPABILITIES.join(", ")}.`);
  }

  transportProblems(raw.transport, problems);

  const inputs = raw.inputs;
  if (!Array.isArray(inputs)) problems.push("inputs must be a list of request fields.");
  else {
    for (const i of inputs) {
      if (!REQUEST_FIELDS.includes(i as RequestField)) {
        problems.push(`inputs names ${String(i)}, which is not one of ${REQUEST_FIELDS.join(", ")}.`);
      }
    }
  }

  const t = typeof raw.timeout === "string" ? TIMEOUT.exec(raw.timeout) : null;
  if (!t) problems.push("timeout must be a number followed by m or s, such as 5m or 30s.");
  const timeoutMs = t ? Number(t[1]) * (t[2] === "m" ? 60_000 : 1000) : 0;

  const retries = raw.retries ?? 0;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > 3) {
    problems.push("retries must be a whole number from 0 to 3.");
  }

  const maxUsd = isObj(raw.cost) ? raw.cost.maxUsd : undefined;
  if (typeof maxUsd !== "number" || !Number.isFinite(maxUsd) || maxUsd < 0) {
    problems.push("cost.maxUsd must be a number of at least 0.");
  }

  const blocking = raw.blocking ?? true;
  if (typeof blocking !== "boolean") problems.push("blocking must be true or false.");

  for (const f of ["tokenEnv", "secretEnv"] as const) {
    const p = envProblem(f, raw[f]);
    if (p) problems.push(p);
  }

  if (problems.length) return { ok: false, problems };
  const manifest: Manifest = {
    apiVersion: "factory.extension/v1",
    name: raw.name as string,
    fills: { capability: capability as Capability },
    transport: raw.transport as Manifest["transport"],
    inputs: inputs as RequestField[],
    timeoutMs,
    retries: retries as number,
    cost: { maxUsd: maxUsd as number },
    blocking: blocking as boolean,
  };
  if (raw.tokenEnv !== undefined) manifest.tokenEnv = raw.tokenEnv as string;
  if (raw.secretEnv !== undefined) manifest.secretEnv = raw.secretEnv as string;
  return { ok: true, manifest };
}
