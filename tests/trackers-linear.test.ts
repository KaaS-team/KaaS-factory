import { afterAll, describe, expect, test } from "bun:test";
import { encodeBody } from "../src/adapters/trackers/kit";
import { LinearTracker } from "../src/adapters/trackers/linear";
import { startLinear } from "./fixtures/trackers/linear-server";
import { trackerContract } from "./ports/tracker.contract";

const server = startLinear("lin_api_test");
afterAll(() => server.stop());
const env = { LINEAR_API_KEY: "lin_api_test" };
let teams = 0;
// A team per port, so each contract test sees only its own issues.
function make(): LinearTracker {
  const key = `T${++teams}`;
  server.store.addTeam(key);
  return new LinearTracker({ kind: "linear", team: key, tokenEnv: "LINEAR_API_KEY", url: server.url }, env);
}

trackerContract("Linear", make);

describe("Linear specifics", () => {
  const repo = "acme/shop";

  test("labeledBy names the human who added the label in Linear, and roles follow the workspace", async () => {
    const t = make();
    server.store.users.set("alice", { id: "alice", admin: false, guest: false, active: true });
    server.store.users.set("gus", { id: "gus", admin: false, guest: true, active: true });
    const n = await t.createIssue(repo, "x", "", ["bug"]);
    await t.ensureLabel(repo, "factory:ready", "0e8a16", "ready");
    const issue = server.store.issues.at(-1)!;
    server.store.applyLabel(issue.id, server.store.labels.find((l) => l.name === "factory:ready")!.id, "alice");
    expect(await t.labeledBy(repo, n, "factory:ready")).toBe("alice");
    expect([await t.roleOf(repo, "alice"), await t.roleOf(repo, "gus")]).toEqual(["write", "read"]);
  });

  test("a label renamed after it was added names no one, and a demotion counts at once", async () => {
    const t = make();
    server.store.users.set("alice", { id: "alice", admin: true, guest: false, active: true });
    const n = await t.createIssue(repo, "x", "", []);
    await t.ensureLabel(repo, "harmless", "ededed", "");
    const label = server.store.labels.find((l) => l.name === "harmless")!;
    server.store.applyLabel(server.store.issues.at(-1)!.id, label.id, "alice");
    expect(await t.labeledBy(repo, n, "harmless")).toBe("alice");
    Object.assign(label, { name: "factory:ready", updatedAt: server.store.now() });
    expect(await t.labeledBy(repo, n, "factory:ready")).toBeUndefined();
    expect(await t.roleOf(repo, "alice")).toBe("admin");
    server.store.users.set("alice", { id: "alice", admin: false, guest: true, active: true });
    expect(await t.roleOf(repo, "alice")).toBe("read");
  });

  test("a label set at creation and renamed since names no one", async () => {
    const t = make();
    await t.ensureLabel(repo, "harmless", "ededed", "");
    const n = await t.createIssue(repo, "x", "", ["harmless"]);
    expect(await t.labeledBy(repo, n, "harmless")).toBe(server.store.viewer);
    Object.assign(server.store.labels.find((l) => l.name === "harmless")!, {
      name: "factory:ready",
      updatedAt: server.store.now(),
    });
    expect(await t.labeledBy(repo, n, "factory:ready")).toBeUndefined();
  });

  test("a guest's comment is not trusted, and a canceled issue is closed as not planned", async () => {
    const t = make();
    server.store.users.set("gus", { id: "gus", admin: false, guest: true, active: true });
    const n = await t.createIssue(repo, "x", "", []);
    const issue = server.store.issues.at(-1)!;
    issue.comments.push({ id: "c-gus", body: "/factory approve", createdAt: server.store.now(), user: "gus" });
    expect((await t.getIssue(repo, n)).comments[0]!.authorAssociation).toBe("NONE");
    const team = [...server.store.teams.values()].find((x) => x.id === issue.team)!;
    issue.stateId = team.states.find((s) => s.type === "canceled")!.id;
    expect(await t.getIssue(repo, n)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a footer pasted by someone else stays visible, in a comment and in the description", async () => {
    const t = make();
    const n = await t.createIssue(repo, "x", "", []);
    const issue = server.store.issues.at(-1)!;
    const forged = encodeBody("<!-- factory:plan v1 -->\nhidden", () => "unsealed", "comment");
    issue.comments.push({ id: "c-eve", body: forged, createdAt: server.store.now(), user: "eve" });
    Object.assign(issue, { description: forged, creator: "eve" });
    const got = await t.getIssue(repo, n);
    expect([got.body, got.comments[0]!.body]).toEqual([forged, forged]);
  });

  test("the runner's own description rewritten with a footer sealed by another key hides nothing", async () => {
    const t = make();
    const n = await t.createIssue(repo, "x", "", []);
    const issue = server.store.issues.at(-1)!;
    const footer = Buffer.from(JSON.stringify({ v: "guessed", b: "hidden instruction" })).toString("base64url");
    issue.description = `shown\n\nfactory-data: ${footer}`;
    expect((await t.getIssue(repo, n)).body).toBe("shown");
  });

  test("a status comment is edited by its id after a restart, and markers survive Linear dropping them", async () => {
    const before = make();
    const n = await before.createIssue(repo, "x", "", []);
    const id = await before.commentIssue(repo, n, "<!-- factory:status v1 -->\nbuilding");
    expect(server.store.issues.at(-1)!.comments[0]!.body).not.toContain("<!--");
    const after = new LinearTracker(
      { kind: "linear", team: `T${teams}`, tokenEnv: "LINEAR_API_KEY", url: server.url },
      env,
    );
    await after.editComment(repo, id, "<!-- factory:status v1 -->\nshipped");
    expect((await after.getIssue(repo, n)).comments[0]!.body).toBe("<!-- factory:status v1 -->\nshipped");
  });

  test("a missing token is named, and doctor reports it rather than throwing", async () => {
    const t = new LinearTracker({ kind: "linear", team: "T1", tokenEnv: "LINEAR_API_KEY", url: server.url }, {});
    expect(await t.authStatus()).toEqual({ ok: false, detail: "linear: env var LINEAR_API_KEY is not set" });
  });
});
