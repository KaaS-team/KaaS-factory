// "GitHub is the state" (audit finding #21): deriveIssueState has to recover
// the exact same answer a live SQLite-backed run would have known, from
// nothing but the issue's labels and comment thread. This is the table that
// makes that claim checkable: every label x marker combination the loop can
// actually produce, mapped to the stage/round counts a resume should use.

import { describe, expect, test } from "bun:test";
import { countMarkers, deriveIssueState, latestDataFor, parseDataMarkers } from "../src/derive";
import type { GhComment, GhIssue } from "../src/github";
import { LABEL } from "../src/labels";

function comment(body: string, id = 1, createdAt = "2026-01-01T00:00:00Z"): GhComment {
  return { id, author: "factory-bot", authorAssociation: "NONE", body, createdAt };
}

function marker(stage: string, json: unknown): string {
  return `<!-- factory:data ${JSON.stringify({ stage, json })} -->`;
}

function issueWith(labels: string[], comments: GhComment[]): GhIssue {
  return { number: 1, title: "t", body: "b", labels: labels.map((name) => ({ name })), comments };
}

describe("parseDataMarkers", () => {
  test("recovers stage and json from every marker across multiple comments", () => {
    const comments = [
      comment(`some text\n\n${marker("triage", { disposition: "proceed" })}`, 1),
      comment(`more text\n\n${marker("plan", { risk: "low" })}`, 2),
    ];
    const markers = parseDataMarkers(comments);
    expect(markers).toEqual([
      { stage: "triage", json: { disposition: "proceed" } },
      { stage: "plan", json: { risk: "low" } },
    ]);
  });

  test("skips a hand-typed comment that merely contains the marker text as unparsable JSON", () => {
    const comments = [comment("<!-- factory:data {not json} -->", 1)];
    expect(parseDataMarkers(comments)).toEqual([]);
  });

  test("finds multiple markers within one comment", () => {
    const body = `${marker("verify", { result: "reject" })}\n${marker("verify", { result: "pass" })}`;
    expect(parseDataMarkers([comment(body)])).toHaveLength(2);
  });
});

describe("latestDataFor / countMarkers", () => {
  const markers = parseDataMarkers([
    comment(marker("verify", { result: "reject" }), 1),
    comment(marker("question", { round: 1 }), 2),
    comment(marker("verify", { result: "pass" }), 3),
  ]);

  test("latestDataFor returns the last marker for that stage, not the first", () => {
    expect(latestDataFor(markers, "verify")).toEqual({ result: "pass" });
  });

  test("latestDataFor returns undefined for a stage with no markers", () => {
    expect(latestDataFor(markers, "plan")).toBeUndefined();
  });

  test("countMarkers counts only that stage", () => {
    expect(countMarkers(markers, "verify")).toBe(2);
    expect(countMarkers(markers, "question")).toBe(1);
    expect(countMarkers(markers, "build")).toBe(0);
  });
});

describe("deriveIssueState: resumeStage", () => {
  test("a fresh issue with no labels or markers resumes at triage", () => {
    expect(deriveIssueState(issueWith([], [])).resumeStage).toBe("triage");
  });

  for (const [label, stage] of [
    [LABEL.triaging, "triage"],
    [LABEL.planning, "plan"],
    [LABEL.building, "build"],
    [LABEL.verifying, "verify"],
    [LABEL.inReview, "pr"],
  ] as const) {
    test(`a running "${label}" label resumes at "${stage}", regardless of older markers`, () => {
      const issue = issueWith([label], [comment(marker("triage", { disposition: "proceed" }))]);
      expect(deriveIssueState(issue).resumeStage).toBe(stage);
    });
  }

  test("a parked issue (no running label) falls back to the last stage marker, for /factory retry", () => {
    const issue = issueWith(
      [LABEL.failed],
      [comment(marker("triage", {}), 1), comment(marker("plan", {}), 2), comment(marker("build", {}), 3)],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("build");
  });

  test("a parked issue's fallback skips non-stage markers (question, status)", () => {
    const issue = issueWith(
      [LABEL.needsHuman],
      [comment(marker("verify", { result: "reject" }), 1), comment(marker("question", { round: 2 }), 2)],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("verify");
  });

  test("a parked issue with no stage markers at all falls back to triage", () => {
    expect(deriveIssueState(issueWith([LABEL.needsHuman], [])).resumeStage).toBe("triage");
  });
});

describe("deriveIssueState: round counts", () => {
  test("questionRounds counts every question marker", () => {
    const issue = issueWith(
      [LABEL.needsInfo],
      [comment(marker("question", { round: 1 }), 1), comment(marker("question", { round: 2 }), 2)],
    );
    expect(deriveIssueState(issue).questionRounds).toBe(2);
  });

  test("rejectRounds counts only verify markers whose result is reject", () => {
    const issue = issueWith(
      [LABEL.building],
      [
        comment(marker("verify", { result: "reject" }), 1),
        comment(marker("verify", { result: "reject" }), 2),
        comment(marker("verify", { result: "pass" }), 3),
        // A build marker that happens to carry a "reject"-shaped payload must
        // not be mistaken for a verify rejection.
        comment(marker("build", { result: "reject" }), 4),
      ],
    );
    expect(deriveIssueState(issue).rejectRounds).toBe(2);
  });
});

describe("deriveIssueState: statusCommentId", () => {
  test("recovers the runner's own status comment id from the thread", () => {
    const issue = issueWith([LABEL.building], [comment("<!-- factory:status v1 -->\nbuilding...", 4242)]);
    expect(deriveIssueState(issue).statusCommentId).toBe(4242);
  });

  test("is undefined when no status comment has been posted yet", () => {
    expect(deriveIssueState(issueWith([LABEL.building], [])).statusCommentId).toBeUndefined();
  });

  test("recovers the latest status comment when more than one exists", () => {
    const issue = issueWith(
      [LABEL.building],
      [comment("<!-- factory:status v1 -->\nround 1", 1), comment("<!-- factory:status v1 -->\nround 2", 2)],
    );
    expect(deriveIssueState(issue).statusCommentId).toBe(2);
  });
});

describe("deriveIssueState: question stage and retry-scoped rejects", () => {
  test("a question marker naming its stage resumes that stage", () => {
    const issue = issueWith(
      [LABEL.needsInfo],
      [comment(marker("triage", {}), 1), comment(marker("question", { round: 1, stage: "plan" }), 2)],
    );
    expect(deriveIssueState(issue).resumeStage).toBe("plan");
  });

  test("verify rejects before a trusted /factory retry are not counted", () => {
    const reject = marker("verify", { result: "reject" });
    const retry: GhComment = { ...comment("/factory retry", 3), author: "param", authorAssociation: "OWNER" };
    const issue = issueWith([LABEL.building], [comment(reject, 1), comment(reject, 2), retry, comment(reject, 4)]);
    expect(deriveIssueState(issue).rejectRounds).toBe(1);
  });
});
