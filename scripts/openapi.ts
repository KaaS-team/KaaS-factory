// Builds src/api/openapi.json from ROUTES and LIVE_EVENTS. tests/api-routes.test.ts pins the committed file.
// Run `bun scripts/openapi.ts` after changing either table.

import { LIVE_EVENTS } from "../src/api/events";
import { type ApiRoute, ROUTES } from "../src/api/routes";
import type { JsonSchema } from "../src/schemas";

export const OPENAPI_PATH = new URL("../src/api/openapi.json", import.meta.url).pathname;

const SCHEME = "bearerAuth";

type Events = Record<string, JsonSchema>;

function parameters(route: ApiRoute): unknown[] {
  const path = [...route.path.matchAll(/:(\w+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const required = (route.req?.required as string[] | undefined) ?? [];
  const props = (route.req?.properties as Record<string, JsonSchema> | undefined) ?? {};
  const query = Object.entries(props).map(([name, schema]) => ({
    name,
    in: "query",
    required: required.includes(name),
    schema,
  }));
  return [...path, ...query];
}

export function buildOpenApi(routes: readonly ApiRoute[], events: Events): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const url = route.path.replace(/:(\w+)/g, "{$1}");
    const content = route.sse
      ? { "text/event-stream": { schema: route.res } }
      : { "application/json": { schema: route.res } };
    paths[url] ??= {};
    paths[url][route.method.toLowerCase()] = {
      operationId: route.id,
      parameters: parameters(route),
      ...(route.auth === "token" ? { security: [{ [SCHEME]: [] }] } : {}),
      responses: { "200": { description: "OK", content } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "KaaS Factory API", version: "1.0.0" },
    paths,
    components: { securitySchemes: { [SCHEME]: { type: "http", scheme: "bearer" } } },
    "x-live-events": events,
  };
}

export function renderOpenApi(): string {
  return `${JSON.stringify(buildOpenApi(ROUTES, LIVE_EVENTS), null, 2)}\n`;
}

if (import.meta.main) await Bun.write(OPENAPI_PATH, renderOpenApi());
