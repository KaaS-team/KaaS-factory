// SPDX-License-Identifier: LicenseRef-KaaS-EE
import { createHash, timingSafeEqual } from "node:crypto";

export const json = (data: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": type } });

export function cookie(req: Request, name: string): string {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

const isHttps = (req: Request) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

export const origin = (req: Request) => `${isHttps(req) ? "https" : "http"}://${new URL(req.url).host}`;

// Lax, because the IdP sends the browser back from another site.
export function setCookie(req: Request, name: string, value: string, maxAge: number): string {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}

export function same(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  return timingSafeEqual(x, createHash("sha256").update(b).digest());
}

// Copies a session response and adds headers to it, so a flow can clear its own cookie.
export function withHeaders(res: Response, extra: [string, string][]): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of extra) headers.append(k, v);
  return new Response(res.body, { status: res.status, headers });
}
