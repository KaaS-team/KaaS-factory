// SPDX-License-Identifier: LicenseRef-KaaS-EE
// OIDC against a fake IdP whose keys this test makes, SAML against a response signed by signxml
// (an independent XML-DSig implementation), and SCIM provisioning through the dashboard's own routes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifySamlResponse } from "../plane/saml";
import { OIDC_ENV, SAML_ENV, ssoExtension } from "../plane/sso";
import { plane, sessionOf } from "./plane";

const fixtures = join(import.meta.dir, "fixtures");
const RESPONSE = readFileSync(join(fixtures, "response.xml"), "utf8");
const CERT = readFileSync(join(fixtures, "idp.crt"), "utf8");
const AT = new Date("2026-10-26T10:01:00Z");
const ISSUER = "https://idp.example";
const BASE = "https://plane.example";

const pair = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function jwt(claims: Record<string, unknown>, alg = "RS256") {
  const head = `${enc({ alg, kid: "k1" })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString("base64url")}`;
}

// The IdP: discovery, the token endpoint (which mints whatever `claims` says) and the JWKS.
function idp(claims: (nonce: string) => Promise<string>) {
  let nonce = "";
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`)
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    if (url === `${ISSUER}/token`) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("code") !== "good" || !form.get("code_verifier"))
        return Response.json({ error: "x" }, { status: 400 });
      return Response.json({ id_token: await claims(nonce) });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [jwk] });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { fetch: fakeFetch, setNonce: (n: string) => (nonce = n) };
}

const env = {
  [OIDC_ENV.issuer]: ISSUER,
  [OIDC_ENV.id]: "plane",
  [OIDC_ENV.secret]: "s3cret",
  [SAML_ENV.cert]: CERT,
  [SAML_ENV.entity]: "https://plane.example/saml",
  [SAML_ENV.issuer]: "https://idp.example/metadata",
  FACTORY_SCIM_TOKEN: "scim-token",
};

function make(claims: (nonce: string) => Promise<string>) {
  const fake = idp(claims);
  const p = plane([ssoExtension(env, () => AT)], { env, fetch: fake.fetch });
  return { ...p, fake };
}

async function oidcSignIn(p: ReturnType<typeof make>) {
  const start = await p.handle(new Request(`${BASE}/auth/oidc`));
  expect(start.status).toBe(302);
  const to = new URL(start.headers.get("location")!);
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  p.fake.setNonce(to.searchParams.get("nonce")!);
  const flow = start.headers.get("set-cookie")!.split(";")[0]!;
  return p.handle(
    new Request(`${BASE}/auth/oidc/callback?code=good&state=${to.searchParams.get("state")}`, {
      headers: { cookie: flow },
    }),
  );
}

const good =
  (over: Record<string, unknown> = {}) =>
  (nonce: string) =>
    jwt({
      iss: ISSUER,
      aud: "plane",
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "Bo@Acme.example",
      nonce,
      ...over,
    });

const scim = (p: ReturnType<typeof make>, method: string, path: string, body?: unknown, token = "scim-token") =>
  p.handle(
    new Request(`${BASE}/scim/v2/Users${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

const acs = (p: ReturnType<typeof make>, xml: string) =>
  p.handle(
    new Request(`${BASE}/auth/saml/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLResponse: Buffer.from(xml).toString("base64") }).toString(),
    }),
  );

const me = async (p: ReturnType<typeof make>, cookie: string) =>
  (await p.handle(new Request(`${BASE}/api/me`, { headers: { cookie } }))).json();

describe("SSO", () => {
  test("SCIM provisions a person, OIDC and SAML sign them in, and SCIM deprovisioning ends their access", async () => {
    const p = make(good());
    expect((await oidcSignIn(p)).status).toBe(403);
    const created = await scim(p, "POST", "", { userName: "Bo@Acme.example", schemas: [] });
    expect(created.status).toBe(201);
    const bo = (await created.json()) as { id: string };
    expect((await scim(p, "POST", "", { userName: "alice@acme.example" })).status).toBe(201);

    const viaOidc = await oidcSignIn(p);
    expect(viaOidc.status).toBe(302);
    expect(await me(p, sessionOf(viaOidc))).toMatchObject({ login: "bo@acme.example", role: "viewer" });

    const viaSaml = await acs(p, RESPONSE);
    expect(viaSaml.status).toBe(302);
    expect(await me(p, sessionOf(viaSaml))).toMatchObject({ login: "alice@acme.example", role: "viewer" });
    // A captured response posted again is refused.
    expect((await acs(p, RESPONSE)).status).toBe(401);

    const listed = (await (await scim(p, "GET", '?filter=userName eq "bo@acme.example"')).json()) as {
      totalResults: number;
    };
    expect(listed.totalResults).toBe(1);
    const off = await scim(p, "PATCH", `/${bo.id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(off.status).toBe(200);
    const after = await p.handle(new Request(`${BASE}/api/me`, { headers: { cookie: sessionOf(viaOidc) } }));
    expect(after.status).toBe(401);
    expect(p.store.audit().map((r) => r.route)).toContain("PATCH /scim/v2/Users/:id");
  });

  test("SCIM needs its own token, and a GitHub-shaped userName is refused", async () => {
    const p = make(good());
    expect((await scim(p, "GET", "", undefined, "wrong")).status).toBe(401);
    expect((await scim(p, "POST", "", { userName: "octocat" })).status).toBe(400);
  });

  test("OIDC refuses a token with a bad signature, another audience, a stale nonce or alg none", async () => {
    for (const bad of [
      async (n: string) => `${(await good()(n)).slice(0, -4)}AAAA`,
      good({ aud: "someone-else" }),
      good({ nonce: "replayed" }),
      good({ exp: 1 }),
      async (n: string) => `${enc({ alg: "none" })}.${enc({ iss: ISSUER, aud: "plane", nonce: n, exp: 9e9 })}.`,
    ]) {
      const p = make(bad);
      await scim(p, "POST", "", { userName: "bo@acme.example" });
      expect((await oidcSignIn(p)).status).toBe(401);
    }
  });

  test("SAML refuses a changed assertion, a wrapped one, the wrong audience and an expired one", () => {
    const opts = { cert: CERT, audience: "https://plane.example/saml", now: AT };
    expect(verifySamlResponse(RESPONSE, opts).login).toBe("alice@acme.example");
    const changed = RESPONSE.replace("Alice@Acme.example", "Mallory@Acme.example");
    expect(() => verifySamlResponse(changed, opts)).toThrow(/digest/);
    const wrapped = RESPONSE.replace(
      "<saml:Issuer>https://idp.example/metadata</saml:Issuer>\n  <samlp:Status>",
      '<saml:Issuer>https://idp.example/metadata</saml:Issuer><saml:Assertion ID="_evil"><saml:Subject><saml:NameID>mallory@acme.example</saml:NameID></saml:Subject></saml:Assertion>\n  <samlp:Status>',
    );
    expect(wrapped).not.toBe(RESPONSE);
    expect(() => verifySamlResponse(wrapped, opts)).toThrow(/one Assertion/);
    expect(() => verifySamlResponse(RESPONSE, { ...opts, audience: "https://other.example" })).toThrow(
      /another service/,
    );
    expect(() => verifySamlResponse(RESPONSE, { ...opts, now: new Date("2026-10-27T00:00:00Z") })).toThrow(/expired/);
    expect(() => verifySamlResponse(`<!DOCTYPE x [<!ENTITY a "b">]>${RESPONSE}`, opts)).toThrow(/DTD/);
  });
});
