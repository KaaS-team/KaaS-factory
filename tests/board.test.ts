// buildBoard is pure so the label→column mapping (and the parked-beats-done
// fix, audit finding #22) is tested without gh or a dashboard server.

import { describe, expect, test } from "bun:test";
import { buildBoard, columnFor, type BoardColumn } from "../dashboard/board";
import { LABEL } from "../src/labels";
import type { GhIssue } from "../src/github";

function issue(number: number, title: string, labelNames: string[]): GhIssue {
  return { number, title, body: "", labels: labelNames.map((name) => ({ name })), comments: [] };
}

describe("columnFor", () => {
  test("a plain issue with no factory:* label is Intake", () => {
    expect(columnFor(["bug"])).toBe("intake");
    expect(columnFor([])).toBe("intake");
  });

  test("factory:ready (queued, not yet claimed) is still Intake", () => {
    expect(columnFor([LABEL.ready])).toBe("intake");
  });

  test.each([
    [LABEL.triaging, "triage"],
    [LABEL.planning, "plan"],
    [LABEL.awaitingApproval, "plan"],
    [LABEL.building, "build"],
    [LABEL.verifying, "verify"],
    [LABEL.inReview, "pr"],
  ] satisfies [string, BoardColumn][])("%s maps to %s", (label, column) => {
    expect(columnFor([label])).toBe(column);
  });

  test.each([LABEL.needsInfo, LABEL.needsHuman, LABEL.failed])(
    "a parked label (%s) goes to attention, never a done bucket",
    (label) => {
      expect(columnFor([label])).toBe("attention");
    },
  );

  test("a parked label wins even alongside a stale state label", () => {
    expect(columnFor([LABEL.building, LABEL.needsHuman])).toBe("attention");
  });
});

describe("buildBoard", () => {
  test("marks an unlabeled issue as needing Mark ready", () => {
    const [card] = buildBoard([issue(1, "Fix the thing", ["bug"])]);
    expect(card!.needsMarkReady).toBe(true);
    expect(card!.column).toBe("intake");
  });

  test("does not offer Mark ready once factory:ready is applied", () => {
    const [card] = buildBoard([issue(1, "Fix the thing", ["bug", LABEL.ready])]);
    expect(card!.needsMarkReady).toBe(false);
  });

  test("does not offer Mark ready on a parked issue", () => {
    const [card] = buildBoard([issue(1, "Fix the thing", [LABEL.needsHuman])]);
    expect(card!.needsMarkReady).toBe(false);
    expect(card!.parkedLabel).toBe(LABEL.needsHuman);
  });

  test("typeLabels excludes lifecycle and monitor labels", () => {
    const [card] = buildBoard([issue(1, "Upgrade hono", ["security", LABEL.monitor, LABEL.building])]);
    expect(card!.typeLabels).toEqual(["security"]);
  });
});
