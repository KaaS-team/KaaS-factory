// SPDX-License-Identifier: LicenseRef-KaaS-EE
// OIDC authorization-code flow with PKCE. The ID token is checked against the issuer's JWKS with
// WebCrypto, so a token is trusted for its signature, issuer, audience, expiry and our nonce.
import { createHash, randomBytes } from "node:crypto";

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly issuer: string;
}

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const TIMEOUT_MS = 10_000;
const SKEW_S = 60;

export async function discover(s: OidcSettings, doFetch: typeof fetch): Promise<Discovery> {
  const res = await doFetch(`${s.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const d = (await res.json()) as Discovery;
  // OIDC Discovery 4.3: the document must name the issuer we asked, or it is someone else's.
  if (!res.ok || d.issuer !== s.issuer) throw new Error("the issuer's discovery document does not match");
  return d;
}

export function authorizeUrl(d: Discovery, s: OidcSettings, redirectUri: string) {
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  const to = new URL(d.authorization_endpoint);
  to.searchParams.set("response_type", "code");
  to.searchParams.set("client_id", s.clientId);
  to.searchParams.set("redirect_uri", redirectUri);
  to.searchParams.set("scope", "openid email");
  to.searchParams.set("state", state);
  to.searchParams.set("nonce", nonce);
  to.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  to.searchParams.set("code_challenge_method", "S256");
  return { url: to.toString(), state, nonce, verifier };
}

interface Jwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

export async function verifyIdToken(
  token: string,
  jwks: { keys: Jwk[] },
  expect: { issuer: string; clientId: string; nonce: string; now?: number },
): Promise<Record<string, unknown>> {
  const [h, p, sig, extra] = token.split(".");
  if (!h || !p || !sig || extra !== undefined) throw new Error("not a JWT");
  const header = JSON.parse(Buffer.from(h, "base64url").toString()) as { alg?: string; kid?: string };
  // Only RS256: "none" and HS256-with-the-public-key are the classic forgeries.
  if (header.alg !== "RS256") throw new Error(`alg ${header.alg} is not allowed`);
  const jwk = jwks.keys.find((k) => k.kty === "RSA" && (header.kid === undefined || k.kid === header.kid));
  if (!jwk) throw new Error("no key in the JWKS signs this token");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(sig, "base64url"),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  const now = expect.now ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expect.issuer) throw new Error("wrong issuer");
  if (!aud.includes(expect.clientId)) throw new Error("the token is for another client");
  if (aud.length > 1 && claims.azp !== expect.clientId) throw new Error("the token was issued to another party");
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= now) throw new Error("token expired");
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > now) throw new Error("token issued in the future");
  if (claims.nonce !== expect.nonce) throw new Error("the token answers another sign-in");
  return claims;
}

export async function exchange(
  d: Discovery,
  s: OidcSettings,
  doFetch: typeof fetch,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<{ idToken: string; jwks: { keys: Jwk[] } }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const res = await doFetch(d.token_endpoint, {
    method: "POST",
    signal,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: s.clientId,
      client_secret: s.clientSecret,
      code_verifier: verifier,
    }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || typeof body.id_token !== "string") throw new Error("the IdP refused the sign-in code");
  const jwks = (await (await doFetch(d.jwks_uri, { signal })).json()) as { keys: Jwk[] };
  return { idToken: body.id_token, jwks };
}
