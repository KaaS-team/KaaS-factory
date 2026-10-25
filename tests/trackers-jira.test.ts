import { afterAll, describe, expect, test } from "bun:test";
import { jiraAuth, JiraTracker } from "../src/adapters/trackers/jira";
import { startJira } from "./fixtures/trackers/jira-server";
import { trackerContract } from "./ports/tracker.contract";

const server = startJira("bot@acme.test:jira_api_test");
afterAll(() => server.stop());
const env = { JIRA_API_TOKEN: "bot@acme.test:jira_api_test" };
let projects = 0;
const spec = (project: string) => ({ kind: "jira" as const, url: server.url, project, tokenEnv: "JIRA_API_TOKEN" });
// A project per port, so each contract test sees only its own issues.
function make(): JiraTracker {
  const key = `P${++projects}`;
  server.store.addProject(key);
  return new JiraTracker(spec(key), env);
}
const project = () => server.store.projects.get(`P${projects}`)!;

trackerContract("Jira", make);

describe("Jira specifics", () => {
  const repo = "acme/shop";

  test("labeledBy names the human who added the label in Jira, and roles follow project permissions", async () => {
    const t = make();
    project().perms.set("acc-alice", ["EDIT_ISSUES", "BROWSE_PROJECTS"]);
    project().perms.set("acc-viewer", ["BROWSE_PROJECTS"]);
    const n = await t.createIssue(repo, "x", "", ["bug"]);
    const i = project().issues.at(-1)!;
    server.store.setLabels(i, [...i.labels, "factory:ready"], "acc-alice");
    expect(await t.labeledBy(repo, n, "factory:ready")).toBe("acc-alice");
    expect(await t.labeledBy(repo, n, "bug")).toBe("acc-factory-bot");
    expect([await t.roleOf(repo, "acc-alice"), await t.roleOf(repo, "acc-viewer")]).toEqual(["write", "read"]);
  });

  test("a viewer's comment is not trusted, and a Won't Do resolution is closed as not planned", async () => {
    const t = make();
    project().perms.set("acc-viewer", ["BROWSE_PROJECTS"]);
    const n = await t.createIssue(repo, "x", "", []);
    const i = project().issues.at(-1)!;
    i.comments.push({ id: "77", body: "/factory approve", created: server.store.now(), author: "acc-viewer" });
    expect((await t.getIssue(repo, n)).comments[0]!.authorAssociation).toBe("NONE");
    Object.assign(i, { status: "Done", resolution: "Won't Do" });
    expect(await t.getIssue(repo, n)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a status comment is edited by its id after a restart", async () => {
    const before = make();
    const n = await before.createIssue(repo, "x", "", []);
    const id = await before.commentIssue(repo, n, "<!-- factory:status v1 -->\nbuilding");
    const after = new JiraTracker(spec(`P${projects}`), env);
    await after.editComment(repo, id, "<!-- factory:status v1 -->\nshipped");
    expect((await after.getIssue(repo, n)).comments[0]!.body).toBe("<!-- factory:status v1 -->\nshipped");
  });

  test("Cloud tokens go as Basic, Data Center tokens as Bearer", () => {
    expect(jiraAuth("me@acme.test:tok")).toEqual({ authorization: `Basic ${btoa("me@acme.test:tok")}` });
    expect(jiraAuth("pat123")).toEqual({ authorization: "Bearer pat123" });
  });

  test("a missing token is named, and doctor reports it rather than throwing", async () => {
    const t = new JiraTracker(spec("P1"), {});
    expect(await t.authStatus()).toEqual({ ok: false, detail: "jira: env var JIRA_API_TOKEN is not set" });
  });
});
