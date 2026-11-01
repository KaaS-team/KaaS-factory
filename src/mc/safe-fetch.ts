// The one outbound door for mission control: https to the host a connection names, no redirect, no
// private address, no key in the URL, bounded in time and size. (No DNS pinning between resolve and
// connect: the host list is the primary control, the address check the second.)

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { redactText } from "./redact";

export interface SafeFetchPolicy {
  readonly hosts: readonly string[];
  readonly allowPrivate?: boolean;
  readonly secret?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface SafeFetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  lookup: (host: string) => Promise<readonly string[]>;
}

const defaultDeps: SafeFetchDeps = {
  fetch: (url, init) => fetch(url, init),
  lookup: async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address),
};

function v4(addr: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  return m ? m.slice(1).map(Number) : undefined;
}

export function isPrivate(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
  const p = v4(a);
  if (p) {
    const [x, y] = p as [number, number];
    return (
      x === 0 ||
      x === 10 ||
      x === 127 ||
      (x === 169 && y === 254) ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 100 && y >= 64 && y <= 127)
    );
  }
  const mapped = /^::ffff:(.+)$/.exec(a);
  if (mapped) {
    const rest = mapped[1] as string;
    if (v4(rest)) return isPrivate(rest);
    const h = rest.split(":").map((x) => Number.parseInt(x, 16));
    if (h.length === 2 && h.every((n) => Number.isFinite(n)))
      return isPrivate(`${h[0]! >> 8}.${h[0]! & 255}.${h[1]! >> 8}.${h[1]! & 255}`);
    return true;
  }
  const first = a.split(":")[0] ?? "";
  if (first === "") return true; // "::", "::1" and other leading-"::" forms
  const n = Number.parseInt(first, 16);
  return (n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80;
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|\[?::1\]?)$/;

export async function safeFetch(
  url: string,
  init: RequestInit,
  policy: SafeFetchPolicy,
  deps: SafeFetchDeps = defaultDeps,
): Promise<Response> {
  try {
    return await run(url, init, policy, deps);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(redactText(msg, policy.secret ? [policy.secret] : []));
  }
}

async function run(url: string, init: RequestInit, policy: SafeFetchPolicy, deps: SafeFetchDeps): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("safeFetch: not a URL");
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopbackHttp = u.protocol === "http:" && policy.allowPrivate === true && LOOPBACK.test(host);
  if (u.protocol !== "https:" && !loopbackHttp) throw new Error(`safeFetch: scheme ${u.protocol} refused, https only`);
  if (u.username || u.password) throw new Error("safeFetch: URL userinfo refused");
  if (!policy.hosts.some((h) => h.toLowerCase() === host)) throw new Error(`safeFetch: host ${host} is not allowed`);
  if (policy.secret && (url.includes(policy.secret) || url.includes(encodeURIComponent(policy.secret))))
    throw new Error("safeFetch: the URL holds the secret");

  const addrs = isIP(host) ? [host] : await deps.lookup(host);
  if (addrs.length === 0) throw new Error(`safeFetch: ${host} did not resolve`);
  for (const addr of addrs) {
    if (isPrivate(addr) && !policy.allowPrivate) throw new Error(`safeFetch: ${host} resolves to a private address`);
  }

  const timeoutMs = policy.timeoutMs ?? 10_000;
  const maxBytes = policy.maxBytes ?? 1024 * 1024;
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`safeFetch: timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([send(url, init, ctl, deps, maxBytes), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function send(
  url: string,
  init: RequestInit,
  ctl: AbortController,
  deps: SafeFetchDeps,
  maxBytes: number,
): Promise<Response> {
  const res = await deps.fetch(url, { ...init, redirect: "manual", signal: ctl.signal });
  if (res.status >= 300 && res.status < 400) throw new Error(`safeFetch: redirect (${res.status}) refused`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`safeFetch: body over ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  const nullBody = [101, 204, 205, 304].includes(res.status);
  return new Response(nullBody ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
