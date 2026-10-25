// What every TrackerPort adapter must do, as the runner relies on it. `make`
// returns a port whose login is "factory-bot", with "factory-bot" an admin.
// Each test uses its own repo, so one store can serve the whole suite.

import { describe, expect, test } from "bun:test";
import type { TrackerPort } from "../../src/ports/scm";

let seq = 0;
const fresh = () => `acme/contract-${++seq}`;
const names = (labels: { name: string }[]) => labels.map((l) => l.name).sort();

export function trackerContract(name: string, make: () => TrackerPort): void {
  describe(`TrackerPort contract: ${name}`, () => {
    test("an issue's title and body come back byte for byte, with no labels or comments lost", async () => {
      const t = make();
      const repo = fresh();
      const body = 'Line one\n\n<!-- factory:data v1 -->\n```json\n{"a": 1}\n```\nnaïve café ✓ "quoted" & <tags>\n';
      const n = await t.createIssue(repo, "Fix the ✓ thing", body, ["bug", "factory:ready"]);
      const issue = await t.getIssue(repo, n);
      expect(issue).toMatchObject({ number: n, title: "Fix the ✓ thing", body, state: "OPEN" });
      expect(names(issue.labels)).toEqual(["bug", "factory:ready"]);
      expect(issue.comments).toEqual([]);
    });

    test("lists hold open issues only, filter by label, and carry each issue's comments", async () => {
      const t = make();
      const repo = fresh();
      const a = await t.createIssue(repo, "a", "", ["factory:ready"]);
      const b = await t.createIssue(repo, "b", "", []);
      const c = await t.createIssue(repo, "c", "", ["factory:ready"]);
      await t.closeIssue(repo, c);
      await t.commentIssue(repo, a, "hello");
      expect((await t.listOpenIssues(repo)).map((i) => i.number).sort()).toEqual([a, b].sort());
      const ready = await t.listIssuesByLabel(repo, "factory:ready");
      expect(ready.map((i) => i.number)).toEqual([a]);
      expect(ready[0]!.comments.map((x) => x.body)).toEqual(["hello"]);
    });

    test("close and reopen set state and stateReason", async () => {
      const t = make();
      const repo = fresh();
      const n = await t.createIssue(repo, "x", "", []);
      await t.closeIssue(repo, n);
      expect(await t.getIssue(repo, n)).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED" });
      await t.reopenIssue(repo, n);
      // blockers.ts reads stateReason on closed issues only, so an open one need not name its history.
      const reopened = await t.getIssue(repo, n);
      expect(reopened.state).toBe("OPEN");
      expect(reopened.stateReason).not.toBe("COMPLETED");
    });

    test("a comment has an id, is authored by the current login, and can be edited in place", async () => {
      const t = make();
      const repo = fresh();
      const n = await t.createIssue(repo, "x", "", []);
      const id = await t.commentIssue(repo, n, "<!-- factory:status v1 -->\nfirst");
      expect(typeof id).toBe("number");
      await t.editComment(repo, id!, "<!-- factory:status v1 -->\nsecond");
      const [c] = (await t.getIssue(repo, n)).comments;
      expect(c).toMatchObject({ id, author: await t.currentLogin(), body: "<!-- factory:status v1 -->\nsecond" });
      expect(["OWNER", "MEMBER", "COLLABORATOR"]).toContain(c!.authorAssociation);
      expect(Date.parse(c!.createdAt)).not.toBeNaN();
      await expect(t.editComment(repo, 999_999, "nope")).rejects.toThrow();
    });

    test("labels add, remove and swap; an unknown label is created on apply", async () => {
      const t = make();
      const repo = fresh();
      const n = await t.createIssue(repo, "x", "", ["keep", "factory:ready"]);
      await t.addLabels(repo, n, ["brand-new"]);
      expect(names((await t.getIssue(repo, n)).labels)).toEqual(["brand-new", "factory:ready", "keep"]);
      await t.removeLabels(repo, n, ["brand-new"]);
      await t.setStateLabel(repo, n, ["factory:ready"], "factory:triaging");
      expect(names((await t.getIssue(repo, n)).labels)).toEqual(["factory:triaging", "keep"]);
      expect(await t.listLabels(repo)).toContain("brand-new");
    });

    test("labeledBy names who applied a label, and nothing for one never applied", async () => {
      const t = make();
      const repo = fresh();
      const n = await t.createIssue(repo, "x", "", []);
      await t.addLabels(repo, n, ["factory:ready"]);
      expect(await t.labeledBy(repo, n, "factory:ready")).toBe(await t.currentLogin());
      expect(await t.labeledBy(repo, n, "never")).toBeUndefined();
      // Triggers file issues already labelled ready, so a label set at creation names its creator too.
      const filed = await t.createIssue(repo, "y", "", ["factory:ready"]);
      expect(await t.labeledBy(repo, filed, "factory:ready")).toBe(await t.currentLogin());
    });

    test("ensureLabel is idempotent and listLabels sees it", async () => {
      const t = make();
      const repo = fresh();
      await t.ensureLabel(repo, "factory:ready", "0e8a16", "ready");
      await t.ensureLabel(repo, "factory:ready", "0e8a16", "ready");
      expect((await t.listLabels(repo)).filter((l) => l === "factory:ready")).toHaveLength(1);
    });

    test("roleOf trusts the factory's own login and no one it does not know", async () => {
      const t = make();
      const repo = fresh();
      expect(await t.roleOf(repo, await t.currentLogin())).toBe("admin");
      expect(await t.roleOf(repo, "a-stranger")).toBe("none");
    });

    test("a missing issue rejects, and auth reports ok", async () => {
      const t = make();
      await expect(t.getIssue(fresh(), 4242)).rejects.toThrow();
      expect((await t.authStatus()).ok).toBe(true);
    });
  });
}
