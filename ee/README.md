# ee/

Organisation features of KaaS Factory, under the KaaS Factory Enterprise License (`LICENSE` here),
not Apache-2.0: SSO, SAML and SCIM, custom roles, audit-log export, multi-tenant orgs and fleet-wide
spend policy.

The core never imports from here. Each feature implements an interface the core defines, so the
core builds, tests and runs with this directory deleted. `tests/licensing.test.ts` fails on an
import that crosses the boundary.

`bun --preload ./ee/register.ts bin/factory ...` turns the features on. SSO, roles and audit export
register always and stay inert until configured. Org mode needs `FACTORY_ORG_MODE_REPO` (the
plane's own repo), and the fleet spend policy needs `FACTORY_SPEND_POLICY` (a JSON file path).

Running code from here in production needs a subscription; development and testing do not.
