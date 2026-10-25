import { afterAll, describe, expect, test } from "bun:test";
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
