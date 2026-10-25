// What every native tracker adapter shares: an HTTP client that reads its token from an env var per
// call, a codec that keeps the runner's <!-- factory --> markers through trackers that strip HTML
// comments, and the numeric ids the TrackerPort speaks. Why: docs/decisions/native-trackers.md.

import { createHash } from "node:crypto";
import type { RepoRole } from "../../ports/scm";

export interface VendorSpec {
  readonly url?: string;
  readonly tokenEnv: string;
}

export class VendorHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface VendorRequest {
  readonly query?: Record<string, string>;
  readonly body?: unknown;
}

// One vendor API. `auth` turns the token into headers, since each vendor spells it differently.
export class VendorClient {
  constructor(
    readonly vendor: string,
    private readonly base: string,
    private readonly tokenEnv: string,
    private readonly auth: (token: string) => Record<string, string>,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {}

  async request<T>(method: string, path: string, opts: VendorRequest = {}): Promise<T> {
    const token = this.env[this.tokenEnv];
    if (!token) throw new VendorHttpError(`${this.vendor}: env var ${this.tokenEnv} is not set`, 0);
    const query = opts.query ? `?${new URLSearchParams(opts.query)}` : "";
    const res = await fetch(`${this.base.replace(/\/+$/, "")}${path}${query}`, {
      method,
      headers: {
        ...this.auth(token),
        accept: "application/json",
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    // The path only: a query can carry a search term, and the vendor's body is cut short.
    if (!res.ok)
      throw new VendorHttpError(
        `${this.vendor} ${method} ${path} answered ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    return (text ? JSON.parse(text) : {}) as T;
  }
}

const FOOTER = "factory-data: ";
// Only letters and digits count, so a tracker that re-renders markdown (escapes, bullets) still matches.
const norm = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
const digest = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// Bodies with a marker carry the original in a last visible line, since Linear, Plane, Jira, ClickUp and
// Asana may each drop an HTML comment. The visible text stays readable for the humans in the tracker.
export function encodeBody(body: string): string {
  if (!body.includes("<!--")) return body;
  const visible = body.replace(/<!--[\s\S]*?-->\n?/g, "").trimEnd();
  const data = Buffer.from(JSON.stringify({ v: digest(norm(visible)), b: body })).toString("base64url");
  return `${visible}\n\n${FOOTER}${data}`;
}

// The original body when the footer is intact and the text above it is unchanged. A human who edited
// the text gets their edit back, without the markers, rather than the factory's stale copy.
export function decodeBody(text: string): string {
  const at = text.lastIndexOf(FOOTER);
  if (at === -1 || (at > 0 && text[at - 1] !== "\n")) return text;
  const token = text
    .slice(at + FOOTER.length)
    .trim()
    .replace(/\\/g, "");
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return text;
  const visible = text.slice(0, at).trimEnd();
  try {
    const data = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { v?: string; b?: string };
    if (typeof data.b === "string" && data.v === digest(norm(visible))) return data.b;
  } catch {
    // not ours
  }
  return visible;
}

// Vendor ids are UUIDs or long strings; the runner keeps comment ids as numbers. A 48-bit hash fits a
// JS number, and the map turns it back into the vendor's id. It fills on every read, so an edit after
// a restart works once the adapter has read the issue again.
export class IdMap {
  private readonly byNumber = new Map<number, string>();

  number(vendorId: string): number {
    const n = Number.parseInt(createHash("sha256").update(vendorId).digest("hex").slice(0, 12), 16) + 1;
    this.byNumber.set(n, vendorId);
    return n;
  }

  vendorId(n: number): string | undefined {
    return this.byNumber.get(n);
  }
}

// GitHub's authorAssociation, from a tracker role: the runner trusts OWNER, MEMBER and COLLABORATOR.
export function association(role: RepoRole): string {
  if (role === "admin") return "OWNER";
  return role === "maintain" || role === "write" ? "MEMBER" : "NONE";
}

// A workspace's three tiers, as most trackers name them, onto the runner's roles.
export function workspaceRole(tier: "admin" | "member" | "guest" | "none"): RepoRole {
  return ({ admin: "admin", member: "write", guest: "read", none: "none" } as const)[tier];
}

// The issue number a tracker shows, from a key such as ENG-42 or PROJ-7.
export function keyNumber(key: string): number {
  const m = /-(\d+)$/.exec(key);
  if (!m) throw new Error(`not an issue key: ${JSON.stringify(key)}`);
  return Number(m[1]);
}
