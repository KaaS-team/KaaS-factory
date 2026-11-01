import { describe, expect, test } from "bun:test";
import { nextToMerge, planStack } from "../src/stacked-prs";

const tasks = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];

describe("planStack", () => {
  test("a three-task epic in task mode is three PRs, each based on the previous", () => {
    expect(planStack(tasks, "task", "factory/epic-9", "main")).toEqual([
      { task: "t1", branch: "factory/epic-9-t1", base: "main" },
      { task: "t2", branch: "factory/epic-9-t2", base: "factory/epic-9-t1", parent: "t1" },
      { task: "t3", branch: "factory/epic-9-t3", base: "factory/epic-9-t2", parent: "t2" },
    ]);
  });

  test("epic mode and a single task stay one PR", () => {
    const one = [{ task: "factory/epic-9", branch: "factory/epic-9", base: "main" }];
    expect(planStack(tasks, "epic", "factory/epic-9", "main")).toEqual(one);
    expect(planStack([{ id: "t1" }], "task", "factory/epic-9", "main")).toEqual(one);
  });
});

describe("nextToMerge", () => {
  const plan = planStack(tasks, "task", "e", "main");

  test("the three PRs merge in order, each retargeted to the trunk", () => {
    const order: string[] = [];
    const merged: string[] = [];
    for (let next = nextToMerge(plan, merged, "main"); next; next = nextToMerge(plan, merged, "main")) {
      expect(next.retarget).toBe("main");
      order.push(next.pr.task);
      merged.push(next.pr.task);
    }
    expect(order).toEqual(["t1", "t2", "t3"]);
  });

  test("a PR whose parent is open waits", () => {
    expect(nextToMerge(plan, [], "main")?.pr.task).toBe("t1");
    expect(nextToMerge(plan, ["t1"], "main")?.pr.task).toBe("t2");
    expect(nextToMerge(plan, ["t1", "t2", "t3"], "main")).toBeUndefined();
  });
});
