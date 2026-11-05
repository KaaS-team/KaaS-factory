import { describe, expect, test } from "bun:test";
import { coreRoutes } from "../src/api/core";
import { fakeClient } from "../src/api/client";
import { fixture, FIXTURE_TOKEN, FixtureTracker } from "../src/api/fixtures";
import { ROUTES } from "../src/api/routes";
import { LABEL } from "../src/labels";
import type { GhIssue } from "../src/ports/scm";
import buildOpenApi from "../src/api/openapi.json";

const WRITES = ROUTES.filter((r) => r.method !== "GET");
const auth = { authorization: `Bearer ${FIXTURE_TOKEN}` };
const post = (
  api: ReturnType<typeof coreRoutes>,
  path: string,
  headers: Record<string, string> = auth,
  body?: unknown,
) =>
  api.fetch(
    new Request(`http://x${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const tracker = (deps: ReturnType<typeof fixture>) => deps.tracker!("acme/web") as FixtureTracker;

describe("write routes", () => {
  test("approve, steer and retry exist as POST token routes", () => {
    expect(WRITES.map((r) => r.id)).toEqual(["runs.approve", "runs.steer", "runs.retry"]);
    for (const r of WRITES) expect(r.auth).toBe("token");
  });

  test("every write route refuses a request without the token and posts nothing", async () => {
    const deps = fixture("two-repos");
    const api = coreRoutes(deps);
    for (const route of WRITES) {
      const path = route.path.replace(":repo", "acme%2Fweb").replace(":issue", "8");
      for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }]) {
        expect((await post(api, path, headers, { text: "x" })).status).toBe(401);
      }
    }
    expect(tracker(deps).posted).toEqual([]);
  });

  test("approve posts the same /factory approve command the CLI posts", async () => {
    const deps = fixture("two-repos");
    const res = await post(coreRoutes(deps), "/api/runs/acme%2Fweb/8/approve");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issue: 8, posted: "/factory approve" });
    expect(tracker(deps).posted).toEqual([{ repo: "acme/web", issue: 8, body: "/factory approve" }]);
  });

  test("steer posts /factory revise with the text, and needs text", async () => {
    const deps = fixture("two-repos");
    const api = coreRoutes(deps);
    const res = await post(api, "/api/runs/acme%2Fweb/8/steer", auth, { text: "use a map" });
    expect(await res.json()).toEqual({ issue: 8, posted: "/factory revise use a map" });
    for (const body of [undefined, {}, { text: "  " }, { text: 3 }])
      expect((await post(api, "/api/runs/acme%2Fweb/8/steer", auth, body)).status).toBe(400);
    expect(tracker(deps).posted.length).toBe(1);
  });

  test("retry posts /factory retry on a parked run", async () => {
    const deps = fixture("two-repos");
    const parked = new FixtureTracker(deps.state("acme/web")!);
    parked.getIssue = async (_r, n): Promise<GhIssue> => ({
      number: n,
      title: "t",
      body: "",
      labels: [{ name: LABEL.needsHuman }],
      comments: [],
    });
    const api = coreRoutes({ ...deps, tracker: () => parked });
    const res = await post(api, "/api/runs/acme%2Fweb/7/retry");
    expect(await res.json()).toEqual({ issue: 7, posted: "/factory retry" });
    expect(parked.posted.map((p) => p.body)).toEqual(["/factory retry"]);
  });

  test("an action the run's state does not allow is a 409 and posts nothing", async () => {
    const deps = fixture("two-repos");
    const api = coreRoutes(deps);
    // #8 awaits approval (no retry); #7 is running and #21 shipped (nothing is waiting).
    const cases: [string, string, string][] = [
      ["acme%2Fweb", "8", "retry"],
      ["acme%2Fweb", "7", "approve"],
      ["acme%2Fapi", "21", "approve"],
    ];
    for (const [repo, issue, verb] of cases) {
      const res = await post(api, `/api/runs/${repo}/${issue}/${verb}`);
      expect(res.status).toBe(409);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    expect((await post(api, "/api/runs/acme%2Fweb/999/approve")).status).toBe(404);
    expect((await post(api, "/api/runs/acme%2Fnone/8/approve")).status).toBe(404);
    expect((await post(api, "/api/runs/acme%2Fweb/abc/approve")).status).toBe(400);
    expect(tracker(deps).posted).toEqual([]);
  });

  test("a server with no tracker answers 501, not a silent success", async () => {
    const { tracker: _drop, ...deps } = fixture("two-repos");
    expect((await post(coreRoutes(deps), "/api/runs/acme%2Fweb/8/approve")).status).toBe(501);
  });

  test("the client calls the write routes and surfaces a refusal", async () => {
    const c = fakeClient("two-repos");
    expect(await c.runs.approve({ repo: "acme/web", issue: 8 })).toEqual({ issue: 8, posted: "/factory approve" });
    expect((await c.runs.steer({ repo: "acme/web", issue: 8, text: "go" })).posted).toBe("/factory revise go");
    await expect(c.runs.retry({ repo: "acme/web", issue: 8 })).rejects.toThrow("not available");
  });

  test("openapi.json lists each write route as a token-gated POST", () => {
    const paths = buildOpenApi.paths as Record<string, Record<string, { operationId: string; security?: unknown }>>;
    for (const r of WRITES) {
      const op = paths[r.path.replace(/:(\w+)/g, "{$1}")]?.post;
      expect(op?.operationId).toBe(r.id);
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
    }
    const steer = paths["/api/runs/{repo}/{issue}/steer"]!.post as unknown as {
      requestBody: { content: Record<string, { schema: { required: string[] } }> };
    };
    expect(steer.requestBody.content["application/json"]!.schema.required).toEqual(["text"]);
  });
});
