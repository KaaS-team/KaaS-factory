import { afterAll, describe, expect, test } from "bun:test";
import { AsanaTracker, gidNumber } from "../src/adapters/trackers/asana";
import { startAsana } from "./fixtures/trackers/asana-server";
import { trackerContract } from "./ports/tracker.contract";

const server = startAsana("asana_pat_test");
afterAll(() => server.stop());
const env = { ASANA_TOKEN: "asana_pat_test" };
let projects = 0;
const spec = (project: string) => ({
  kind: "asana" as const,
  workspace: "ws1",
  project,
  tokenEnv: "ASANA_TOKEN",
  url: server.url,
});
// A project per port, so each contract test sees only its own tasks.
function make(): AsanaTracker {
  const gid = String(1_201_000_000_000_000 + ++projects);
  server.store.projects.add(gid);
  return new AsanaTracker(spec(gid), env);
}

trackerContract("Asana", make);

describe("Asana specifics", () => {
  const repo = "acme/shop";

  test("labeledBy names the human who tagged the task, even after the tag is renamed", async () => {
    const t = make();
    server.store.members.set("1200000000000002", { is_admin: false, is_guest: false, is_active: true });
    server.store.members.set("1200000000000003", { is_admin: false, is_guest: true, is_active: true });
    const n = await t.createIssue(repo, "x", "", ["bug"]);
    await t.ensureLabel(repo, "harmless", "ededed", "");
    const tag = server.store.tags.find((x) => x.name === "harmless")!;
    server.store.addTag(server.store.tasks.at(-1)!, tag.gid, "1200000000000003");
    tag.name = "factory:ready";
    expect(await t.labeledBy(repo, n, "factory:ready")).toBe("1200000000000003");
    expect(await t.labeledBy(repo, n, "bug")).toBe(server.store.me);
    expect([await t.roleOf(repo, "1200000000000002"), await t.roleOf(repo, "1200000000000003")]).toEqual([
      "write",
      "read",
    ]);
  });

  test("a guest's comment is not trusted, and a deactivated member is no one", async () => {
    const t = make();
    server.store.members.set("1200000000000003", { is_admin: false, is_guest: true, is_active: true });
    server.store.members.set("1200000000000004", { is_admin: true, is_guest: false, is_active: false });
    const n = await t.createIssue(repo, "x", "", []);
    const task = server.store.tasks.at(-1)!;
    server.store.stories.push({
      gid: server.store.gid(),
      task: task.gid,
      resource_subtype: "comment_added",
      text: "/factory approve",
      created_at: server.store.now(),
      created_by: "1200000000000003",
    });
    expect((await t.getIssue(repo, n)).comments[0]!.authorAssociation).toBe("NONE");
    expect(await t.roleOf(repo, "1200000000000004")).toBe("none");
  });

  test("a status comment is edited by its id after a restart", async () => {
    const before = make();
    const n = await before.createIssue(repo, "x", "", []);
    const id = await before.commentIssue(repo, n, "<!-- factory:status v1 -->\nbuilding");
    const after = new AsanaTracker(spec(String(1_201_000_000_000_000 + projects)), env);
    await after.editComment(repo, id, "<!-- factory:status v1 -->\nshipped");
    expect((await after.getIssue(repo, n)).comments[0]!.body).toBe("<!-- factory:status v1 -->\nshipped");
  });

  test("a task or comment in another project is refused, though the token can reach it", async () => {
    const other = make();
    const n = await other.createIssue(repo, "elsewhere", "", []);
    const id = await other.commentIssue(repo, n, "status");
    const t = make();
    await expect(t.getIssue(repo, n)).rejects.toThrow("is not in project");
    await expect(t.commentIssue(repo, n, "x")).rejects.toThrow("is not in project");
    await expect(t.closeIssue(repo, n)).rejects.toThrow("is not in project");
    await expect(t.editComment(repo, id, "x")).rejects.toThrow("no comment");
  });

  test("a gid past a safe integer is refused rather than rounded", () => {
    expect(gidNumber("1205000000000001")).toBe(1205000000000001);
    expect(() => gidNumber("12050000000000011")).toThrow("not a safe integer");
  });

  test("a missing token is named, and doctor reports it rather than throwing", async () => {
    const t = new AsanaTracker(spec("1"), {});
    expect(await t.authStatus()).toEqual({ ok: false, detail: "asana: env var ASANA_TOKEN is not set" });
  });
});
