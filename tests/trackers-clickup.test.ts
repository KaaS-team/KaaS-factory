import { afterAll, describe, expect, test } from "bun:test";
import { ClickUpTracker, type ClickUpSpec, taskNumber } from "../src/adapters/trackers/clickup";
import { startClickUp } from "./fixtures/trackers/clickup-server";
import { trackerContract } from "./ports/tracker.contract";

const server = startClickUp("pk_clickup_test");
afterAll(() => server.stop());
const env = { CLICKUP_API_TOKEN: "pk_clickup_test" };
let lists = 0;
const spec = (list: string, labelTrust: ClickUpSpec["labelTrust"] = "creator"): ClickUpSpec => ({
  kind: "clickup",
  workspace: "ws1",
  list,
  tokenEnv: "CLICKUP_API_TOKEN",
  url: server.url,
  labelTrust,
});
// A List per port, so each contract test sees only its own tasks.
function make(trust?: ClickUpSpec["labelTrust"]): ClickUpTracker {
  const id = `l${++lists}`;
  server.store.addList(id);
  return new ClickUpTracker(spec(id, trust), env);
}

// The contract's labeledBy needs an answer, which ClickUp gives only with labelTrust opted in.
trackerContract("ClickUp", () => make());

describe("ClickUp specifics", () => {
  const repo = "acme/shop";

  test("without labelTrust a tag names no one, so label triggers fail closed, and doctor says so", async () => {
    const t = make("none");
    const n = await t.createIssue(repo, "x", "", ["factory:ready"]);
    expect(await t.labeledBy(repo, n, "factory:ready")).toBeUndefined();
    expect((await t.authStatus()).detail).toContain("label triggers off");
  });

  test("with labelTrust a tag is credited to the task's creator, who may be a guest", async () => {
    const t = make();
    server.store.members.push({ user: { id: 2002, role: 4 } });
    const n = await t.createIssue(repo, "x", "", []);
    server.store.tasks.at(-1)!.creator = 2002;
    await t.addLabels(repo, n, ["factory:ready"]);
    expect(await t.labeledBy(repo, n, "factory:ready")).toBe("2002");
    expect(await t.roleOf(repo, "2002")).toBe("read");
  });

  test("a guest's comment is not trusted, and a cancelled task is closed as not planned", async () => {
    const t = make();
    server.store.members.push({ user: { id: 2002, role: 4 } });
    const n = await t.createIssue(repo, "x", "", []);
    const task = server.store.tasks.at(-1)!;
    task.comments.push({ id: "90149999999", comment_text: "/factory approve", date: server.store.now(), user: 2002 });
    expect((await t.getIssue(repo, n)).comments[0]!.authorAssociation).toBe("NONE");
    task.status = "cancelled";
    expect(await t.getIssue(repo, n)).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });
  });

  test("a status comment is edited by its id after a restart", async () => {
    const before = make();
    const n = await before.createIssue(repo, "x", "", []);
    const id = await before.commentIssue(repo, n, "<!-- factory:status v1 -->\nbuilding");
    const after = new ClickUpTracker(spec(`l${lists}`), env);
    await after.editComment(repo, id, "<!-- factory:status v1 -->\nshipped");
    expect((await after.getIssue(repo, n)).comments[0]!.body).toBe("<!-- factory:status v1 -->\nshipped");
  });

  test("a task or comment in another List is refused, though the token can reach it", async () => {
    const other = make();
    const n = await other.createIssue(repo, "elsewhere", "", []);
    const id = await other.commentIssue(repo, n, "status");
    const t = make();
    await expect(t.getIssue(repo, n)).rejects.toThrow("is not in list");
    await expect(t.commentIssue(repo, n, "x")).rejects.toThrow("is not in list");
    await expect(t.closeIssue(repo, n)).rejects.toThrow("is not in list");
    await expect(t.editComment(repo, id, "x")).rejects.toThrow("no comment");
  });

  test("a task id too long for a safe integer is refused rather than rounded", () => {
    expect(taskNumber("86a1b2c3")).toBe(Number.parseInt("86a1b2c3", 36));
    expect(() => taskNumber("zzzzzzzzzzzz")).toThrow("not a base-36 number");
  });

  test("a missing token is named, and doctor reports it rather than throwing", async () => {
    const t = new ClickUpTracker(spec("l1"), {});
    expect(await t.authStatus()).toEqual({ ok: false, detail: "clickup: env var CLICKUP_API_TOKEN is not set" });
  });
});
