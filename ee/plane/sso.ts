// SPDX-License-Identifier: LicenseRef-KaaS-EE
// Sign-in through the company IdP (OIDC or SAML) and provisioning through SCIM. The IdP proves
// who someone is; plane membership still decides whether they get in and with which role.
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { Route } from "../../dashboard/plane/access";
import type { PlaneContext, PlaneExtension } from "../../dashboard/plane/extension";
import { cookie, json, origin, same, setCookie, withHeaders } from "./http";
import { authorizeUrl, discover, exchange, type OidcSettings, verifyIdToken } from "./oidc";
import { verifySamlResponse } from "./saml";
import { SCIM_TOKEN_ENV, scimRoutes } from "./scim";

export const OIDC_ENV = { issuer: "FACTORY_OIDC_ISSUER", id: "FACTORY_OIDC_CLIENT_ID", secret: "FACTORY_OIDC_CLIENT_SECRET" };
export const SAML_ENV = {
  cert: "FACTORY_SAML_IDP_CERT",
  sso: "FACTORY_SAML_IDP_SSO_URL",
  issuer: "FACTORY_SAML_IDP_ISSUER",
  entity: "FACTORY_SAML_SP_ENTITY",
};
const OIDC_COOKIE = "factory_oidc";
const SAML_COOKIE = "factory_saml";
const FLOW_TTL_S = 600;

// Sign-in either way ends here: only a member gets a session, and both outcomes are audited.
function finish(ctx: PlaneContext, req: Request, login: string, route: string, clear: string): Response {
  const who = ctx.member(login);
  ctx.store.record({ actor: login, role: who?.role ?? "none", route, issue: null, status: who ? 302 : 403 });
  const done = [["set-cookie", setCookie(req, clear, "", 0)]] as [string, string][];
  if (!who) return withHeaders(json({ error: `${login} is not a member of this factory; ask an owner to add you` }, 403), done);
  return withHeaders(ctx.startSession(req, login), done);
}

function oidcRoutes(ctx: PlaneContext): Route[] {
  const settings = (): OidcSettings | null => {
    const [issuer, clientId, clientSecret] = [OIDC_ENV.issuer, OIDC_ENV.id, OIDC_ENV.secret].map((k) => ctx.env[k] ?? "");
    return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null;
  };
  const off = () => json({ error: "OIDC sign-in is not set up on this factory" }, 404);
  const redirect = (req: Request) => `${origin(req)}/auth/oidc/callback`;
  return [
    {
      method: "GET",
      pattern: /^\/auth\/oidc$/,
      label: "GET /auth/oidc",
      public: true,
      handler: async (req) => {
        const s = settings();
        if (!s) return off();
        const a = authorizeUrl(await discover(s, ctx.fetch), s, redirect(req));
        const flow = `${a.state}.${a.nonce}.${a.verifier}`;
        return new Response(null, {
          status: 302,
          headers: { location: a.url, "set-cookie": setCookie(req, OIDC_COOKIE, flow, FLOW_TTL_S) },
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/auth\/oidc\/callback$/,
      label: "GET /auth/oidc/callback",
      public: true,
      handler: async (req, url) => {
        const s = settings();
        if (!s) return off();
        const [state = "", nonce = "", verifier = ""] = cookie(req, OIDC_COOKIE).split(".");
        if (!state || !same(url.searchParams.get("state") ?? "", state))
          return json({ error: "sign-in expired, start again" }, 400);
        let login: string;
        try {
          const d = await discover(s, ctx.fetch);
          const { idToken, jwks } = await exchange(d, s, ctx.fetch, url.searchParams.get("code") ?? "", redirect(req), verifier);
          const claims = await verifyIdToken(idToken, jwks, { issuer: s.issuer, clientId: s.clientId, nonce });
          if (typeof claims.email !== "string" || claims.email_verified === false)
            throw new Error("the IdP did not vouch for an email address");
          login = claims.email.trim().toLowerCase();
        } catch (e) {
          return json({ error: (e as Error).message }, 401);
        }
        return finish(ctx, req, login, "sign-in oidc", OIDC_COOKIE);
      },
    },
  ];
}

function samlRoutes(ctx: PlaneContext, now: () => Date): Route[] {
  const cert = () => (ctx.env[SAML_ENV.cert] ?? "").replace(/\\n/g, "\n");
  const entity = () => ctx.env[SAML_ENV.entity] ?? "";
  const on = () => cert() !== "" && entity() !== "";
  const off = () => json({ error: "SAML sign-in is not set up on this factory" }, 404);
  // An assertion is good once: a replayed POST of a captured response is refused until it expires.
  const seen = new Map<string, number>();
  return [
    {
      method: "GET",
      pattern: /^\/auth\/saml$/,
      label: "GET /auth/saml",
      public: true,
      handler: (req) => {
        const sso = ctx.env[SAML_ENV.sso] ?? "";
        if (!on() || !sso) return off();
        const id = `_${randomBytes(16).toString("hex")}`;
        const request = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${origin(req)}/auth/saml/acs"><saml:Issuer>${entity()}</saml:Issuer></samlp:AuthnRequest>`;
        const to = new URL(sso);
        to.searchParams.set("SAMLRequest", deflateRawSync(request).toString("base64"));
        return new Response(null, {
          status: 302,
          headers: { location: to.toString(), "set-cookie": setCookie(req, SAML_COOKIE, id, FLOW_TTL_S) },
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/auth\/saml\/acs$/,
      label: "POST /auth/saml/acs",
      public: true,
      handler: async (req) => {
        if (!on()) return off();
        const form = new URLSearchParams(await req.text());
        let login: string;
        try {
          const xml = Buffer.from(form.get("SAMLResponse") ?? "", "base64").toString("utf8");
          const id = verifySamlResponse(xml, {
            cert: cert(),
            audience: entity(),
            issuer: ctx.env[SAML_ENV.issuer] || undefined,
            recipient: `${origin(req)}/auth/saml/acs`,
            inResponseTo: cookie(req, SAML_COOKIE) || undefined,
            now: now(),
          });
          for (const [k, until] of seen) if (until < now().getTime()) seen.delete(k);
          if (seen.has(id.assertionId)) throw new Error("this assertion was already used");
          seen.set(id.assertionId, id.notOnOrAfter);
          login = id.login;
        } catch (e) {
          return json({ error: (e as Error).message }, 401);
        }
        return finish(ctx, req, login, "sign-in saml", SAML_COOKIE);
      },
    },
  ];
}

export function ssoExtension(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): PlaneExtension {
  return {
    name: "sso",
    guards: () => Boolean(env[OIDC_ENV.issuer] || env[SAML_ENV.cert] || env[SCIM_TOKEN_ENV]),
    routes: (ctx) => [...oidcRoutes(ctx), ...samlRoutes(ctx, now), ...scimRoutes(ctx)],
  };
}
