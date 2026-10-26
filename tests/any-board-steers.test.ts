// Steerable from any board: connect an issue board and a task started there runs, and an approve sent
// through it reaches the runner. Every tracker manifest is walked, each against its vendor's fixture.
import { afterAll, describe, expect, test } from "bun:test";
import { parseChatOps } from "../src/chatops";
import { loadManifests } from "../src/integrations/catalogue";
import { commandRoutes } from "../dashboard/plane/commands";
import { applySteer, mayApply, parseSteer, roleFor, type Steer } from "../src/integrations/steer";
import { LABEL } from "../src/labels";
import { startBoards } from "./fixtures/boards";

const boards = startBoards();
afterAll(() => boards.stop());
const REPO = "acme/shop";
const trackers = loadManifests()
  .filter((m) => m.kind === "tracker")
  .map((m) => m.configKind ?? m.name)
  .sort();

describe("any board steers", () => {
  test("every tracker manifest has a board in the steering suite", () => {
    expect(Object.keys(boards.make).sort()).toEqual(trackers);
  });

  test("a steer needs the role of the dashboard route it stands for", () => {
    const routes = commandRoutes({
      github: {} as never,
      repoOf: () => REPO,
      actorOf: () => undefined,
      invalidate: () => {},
    });
    const role = (label: string) => routes.find((r) => r.label === label)!.role;
    const steer = (action: string): Steer => ({ kind: "act", issue: 1, action: action as never, text: "" });
    expect(roleFor({ kind: "start", title: "t", body: "" })).toBe(role("POST /api/tasks")!);
    for (const [action, name] of [
      ["approve", "approve-plan"],
      ["revise", "revise"],
      ["answer", "answer"],
      ["retry", "retry"],
      ["cancel", "cancel"],
    ])
      expect(roleFor(steer(action!)), action).toBe(role(`POST /api/issues/:n/${name}`)!);
    expect(mayApply({ login: "vic", role: "viewer" }, steer("approve"))).toBe(false);
    expect(mayApply({ login: "amy", role: "approver" }, steer("approve"))).toBe(true);
    expect(mayApply({ login: "amy", role: "approver" }, steer("retry"))).toBe(false);
  });

  test("on every board, a task started there is ready, and approve on it is a command the runner reads", async () => {
    for (const kind of trackers) {
      const tracker = boards.make[kind]!();
      const { issue } = await applySteer(tracker, REPO, parseSteer("start: Fix the cart\nIt drops items")!, "Ada");
      const created = await tracker.getIssue(REPO, issue);
      expect(
        created.labels.map((l) => l.name),
        kind,
      ).toContain(LABEL.ready);
      await tracker.addLabels(REPO, issue, [LABEL.awaitingApproval]);
      await applySteer(tracker, REPO, parseSteer("approve", issue)!, `Ada on ${kind}`);
      const last = (await tracker.getIssue(REPO, issue)).comments.at(-1)!.body;
      expect(parseChatOps(last), kind).toEqual({ type: "approve" });
    }
  });
});
