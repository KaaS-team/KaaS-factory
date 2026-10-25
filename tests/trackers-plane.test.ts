import { afterAll, describe, expect, test } from "bun:test";
import { fromHtml, PlaneTracker } from "../src/adapters/trackers/plane";
import { startPlane } from "./fixtures/trackers/plane-server";
import { trackerContract } from "./ports/tracker.contract";

const server = startPlane("plane_api_test");
afterAll(() => server.stop());
const env = { PLANE_API_KEY: "plane_api_test" };
let projects = 0;
const spec = (project: string) => ({
  kind: "plane" as const,
  workspace: "acme",
  project,
  tokenEnv: "PLANE_API_KEY",
  url: server.url,
});
// A project per port, so each contract test sees only its own work items.
function make(): PlaneTracker {
  const id = `p${++projects}`;
  server.store.addProject(id);
  return new PlaneTracker(spec(id), env);
}
const project = () => server.store.projects.get(`p${projects}`)!;

trackerContract("Plane", make);

describe("Plane specifics", () => {
  const repo = "acme/shop";

  test("labeledBy names the human who added the label in Plane, and roles follow the project tiers", async () => {
    const t = make();
    project().members.push({ member_id: "alice", role: 15 }, { member_id: "gus", role: 5 });
    const n = await t.createIssue(repo, "x", "", ["bug"]);
    await t.ensureLabel(repo, "factory:ready", "0e8a16", "ready");
    const p = project();
    server.store.applyLabel(p.items.at(-1)!, p.labels.find((l) => l.name === "factory:ready")!.id, "alice");
    expect(await t.labeledBy(repo, n, "factory:ready")).toBe("alice");
    expect(await t.labeledBy(repo, n, "bug")).toBe("factory-bot");
    expect([await t.roleOf(repo, "alice"), await t.roleOf(repo, "gus"), await t.roleOf(repo, "eve")]).toEqual([
      "write",
      "read",
      "none",
    ]);
  });

  test("a guest's comment is not trusted, and a cancelled item is closed as not planned", async () => {
    const t = make();
    project().members.push({ member_id: "gus", role: 5 });
    const n = await t.createIssue(repo, "x", "", []);
    const w = project().items.at(-1)!;
    w.comments.push({
      id: "c-gus",
      comment_html: "<p>/factory approve</p>",
      created_at: server.store.now(),
      actor_id: "gus",
    });
    const [c] = (await t.getIssue(repo, n)).comments;
    expect(c).toMatchObject({ authorAssociation: "NONE", body: "/factory approve" });
    w.state_id = project().states.find((s) => s.group === "cancelled")!.id;
    expect(await t.getIssue(repo, n)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a status comment is edited by its id after a restart", async () => {
    const before = make();
    const n = await before.createIssue(repo, "x", "", []);
    const id = await before.commentIssue(repo, n, "<!-- factory:status v1 -->\nbuilding");
    const after = new PlaneTracker(spec(`p${projects}`), env);
    await after.editComment(repo, id, "<!-- factory:status v1 -->\nshipped");
    expect((await after.getIssue(repo, n)).comments[0]!.body).toBe("<!-- factory:status v1 -->\nshipped");
  });

  test("HTML a human wrote in Plane reads back as plain lines", () => {
    expect(fromHtml("<p>Fix the <strong>login</strong> &amp; signup</p><p>today</p>")).toBe(
      "Fix the login & signup\ntoday",
    );
  });

  test("a missing token is named, and doctor reports it rather than throwing", async () => {
    const t = new PlaneTracker(spec("p1"), {});
    expect(await t.authStatus()).toEqual({ ok: false, detail: "plane: env var PLANE_API_KEY is not set" });
  });
});
