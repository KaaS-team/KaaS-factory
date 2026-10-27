// Two issues whose plans name the same file do not build in parallel: the later one waits under
// factory:overlap, says why once, and builds the poll the earlier one leaves flight.

import { afterAll, describe, expect, test } from "bun:test";
import { withDataMarker } from "../src/engine/common";
import { LABEL } from "../src/labels";
import { overlapping } from "../src/overlap";
import { defaultWorkflow } from "../src/engine/workflows";
import { advanceIssue } from "../src/watch";
import { engine, removeEngineDirs } from "./engine-harness";
import { nextIso, visibleLeaks } from "./harness";

afterAll(removeEngineDirs);

const planFor = (files: string[], autoApproveEligible = true) => ({
  "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
  "plan.json": JSON.stringify({ risk: "low", revision: 1, files, autoApproveEligible }),
});

// Issue #2 is the later one; issue #1 is already building a plan that names `earlier`.
function setup(earlier: string[], mine: string[], autoApproveEligible = true) {
  const e = engine(
    defaultWorkflow(),
    0,
    {},
    {},
    {},
    {
      issue: 2,
      outputs: {
        plan: [planFor(mine, autoApproveEligible)],
      },
    },
  );
  e.github.issues.set(1, {
    number: 1,
    title: "Issue 1",
    body: "do the thing",
    labels: [{ name: LABEL.building }],
    comments: [
      {
        id: 1,
        author: "factory-bot",
        authorAssociation: "OWNER",
        body: withDataMarker("plan", "plan", { files: earlier }),
        createdAt: nextIso(),
      },
    ],
  });
  const later = () => e.github.issues.get(2)!;
  const advance = () => advanceIssue(e.deps, e.config, later());
  const overlapComments = () => later().comments.filter((c) => c.body.includes('"stage":"overlap"'));
  const built = () => e.executor.pinned.some(([stage]) => stage === "build");
  return { ...e, later, advance, overlapComments, built };
}

describe("overlapping()", () => {
  test("equal paths overlap, disjoint lists do not", () => {
    const inFlight = [{ issue: 1, files: ["src/a.ts", "src/b.ts"] }];
    expect(overlapping({ issue: 2, files: ["src/b.ts", "src/c.ts"] }, inFlight)).toEqual([
      { issue: 1, shared: ["src/b.ts"] },
    ]);
    expect(overlapping({ issue: 2, files: ["src/c.ts"] }, inFlight)).toEqual([]);
    expect(overlapping({ issue: 2, files: ["src"] }, inFlight)).toEqual([]);
  });

  test("only an earlier issue blocks", () => {
    expect(overlapping({ issue: 1, files: ["a"] }, [{ issue: 2, files: ["a"] }])).toEqual([]);
  });
});

describe("overlap", () => {
  test("two planned issues that share a file, second waits and its comment names the first", async () => {
    const t = setup(["src/a.ts"], ["src/a.ts", "src/z.ts"]);
    expect(await t.run()).toBe("awaiting-approval");
    expect(t.later().labels.map((l) => l.name)).toEqual([LABEL.overlap]);
    expect(t.overlapComments()).toHaveLength(1);
    const body = t.overlapComments()[0]!.body;
    expect(body).toContain("#1");
    expect(body).toContain("src/a.ts");
    expect(visibleLeaks(body)).toEqual([]);
    expect(t.built()).toBe(false);
  });

  test("a plan a human approves waits the same way", async () => {
    const t = setup(["src/a.ts"], ["src/a.ts"], false);
    expect(await t.run()).toBe("awaiting-approval");
    expect(t.later().labels.map((l) => l.name)).toEqual([LABEL.awaitingApproval]);
    t.github.say(2, "/factory approve");
    expect(await t.advance()).toBe("awaiting-approval");
    expect(t.later().labels.map((l) => l.name)).toEqual([LABEL.overlap]);
    expect(t.overlapComments()).toHaveLength(1);
    expect(t.built()).toBe(false);
  });

  test("two planned issues with disjoint files both build", async () => {
    const t = setup(["src/a.ts"], ["src/z.ts"]);
    expect(await t.run()).toBe("shipped");
    expect(t.github.seenLabels.has(LABEL.overlap)).toBe(false);
    expect(t.overlapComments()).toHaveLength(0);
    expect(t.built()).toBe(true);
  });

  test("wait lifts once the earlier issue's PR merges or closes, with no second comment", async () => {
    const t = setup(["src/a.ts"], ["src/a.ts"]);
    await t.run();
    expect(await t.advance()).toBe("waiting");
    expect(t.later().labels.map((l) => l.name)).toEqual([LABEL.overlap]);
    expect(t.overlapComments()).toHaveLength(1);
    t.github.issues.get(1)!.labels = [];
    expect(await t.advance()).toBe("shipped");
    expect(t.built()).toBe(true);
    expect(t.overlapComments()).toHaveLength(1);
  });
});
