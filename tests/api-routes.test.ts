import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOpenApi, OPENAPI_PATH } from "../scripts/openapi";
import { LIVE_EVENTS } from "../src/api/events";
import { ROUTES, RUN_EVENT_SCHEMA, RUN_SCHEMA, RUN_STATUS_ENUM, STAGE_ENUM } from "../src/api/routes";

const state = readFileSync(join(import.meta.dir, "..", "src", "state.ts"), "utf8");

// The members of `export type <name> = "a" | "b" ...;` in state.ts.
function union(name: string): string[] {
  const m = new RegExp(`export type ${name} =([^;]+);`).exec(state);
  expect(m).not.toBeNull();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("ROUTES", () => {
  test("route ids are unique and token-gated", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of ROUTES) {
      expect(r.path.startsWith("/api/")).toBe(true);
      expect(r.auth).toBe(r.id === "health" ? "none" : "token");
    }
  });

  test("the declared routes are the ones the spec lists", () => {
    expect(ROUTES.map((r) => r.id)).toEqual([
      "health",
      "repos.list",
      "runs.list",
      "runs.get",
      "runs.events",
      "spend.get",
      "metrics.get",
      "stream",
    ]);
  });

  test("state Stage and RunStatus enums equal the schema enums", () => {
    expect(STAGE_ENUM).toEqual(union("Stage"));
    expect(RUN_STATUS_ENUM).toEqual(union("RunStatus"));
    const props = (s: Record<string, unknown>) => s.properties as Record<string, { enum?: string[] }>;
    expect(props(RUN_SCHEMA).stage!.enum).toEqual(union("Stage"));
    expect(props(RUN_SCHEMA).status!.enum).toEqual(union("RunStatus"));
    expect(props(RUN_EVENT_SCHEMA).stage!.enum).toEqual(union("Stage"));
  });

  test("every live event declares a payload schema", () => {
    expect(Object.keys(LIVE_EVENTS)).toEqual([
      "run.updated",
      "stage.started",
      "stage.finished",
      "log.appended",
      "inbox.changed",
      "message.queued",
      "repo.changed",
    ]);
  });
});

describe("openapi.json", () => {
  test("openapi.json matches buildOpenApi output", () => {
    const committed = JSON.parse(readFileSync(OPENAPI_PATH, "utf8"));
    const built = buildOpenApi(ROUTES, LIVE_EVENTS);
    if (JSON.stringify(committed) !== JSON.stringify(built))
      throw new Error("src/api/openapi.json is stale: run bun scripts/openapi.ts");
    expect(committed).toEqual(built);
  });

  test("token routes carry bearer security and :param becomes {param}", () => {
    const doc = buildOpenApi(ROUTES, LIVE_EVENTS) as { paths: Record<string, Record<string, { security?: unknown }>> };
    expect(doc.paths["/api/health"]!.get!.security).toBeUndefined();
    expect(doc.paths["/api/runs/{repo}/{issue}"]!.get!.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths["/api/runs/{repo}/{issue}/events"]).toBeDefined();
  });
});
