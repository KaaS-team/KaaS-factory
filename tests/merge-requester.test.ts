// approvals.requester_cannot_approve (#358): the issue's author may not approve its merge.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard } from "../dashboard/server";
import type { DashboardProject } from "../dashboard/project";
import { DEFAULT_CONFIG } from "../src/config";
import { GitHub, type GhIssue, type GhPr, type MergeReadiness, type PrStatus } from "../src/github";
import { decideOperatorMerge } from "../src/merge-policy";
import { FactoryState } from "../src/state";

mkdirSync(tmpdir(), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "factory-requester-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const readiness: MergeReadiness = {
  state: "open",
  isDraft: false,
  baseRefName: "main",
  headRefOid: "sha1",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  hasUnresolvedReviewThreads: false,
  changesRequestedStale: false,
};
const ci = {
  prNumber: 1,
  headSha: "sha1",
  status: "passed" as const,
  checks: [{ name: "b", status: "COMPLETED", conclusion: "SUCCESS" }],
};

describe("decideOperatorMerge", () => {
  test("the requester approving is refused with requester_cannot_approve", () => {
    const d = decideOperatorMerge(readiness, ci, undefined, {
      approver: "Ana",
      requester: "ana",
      requesterCannotApprove: true,
    });
    expect(d.outcome).toBe("refuse");
    if (d.outcome === "refuse") expect(d.refusals.map((r) => r.reason)).toEqual(["requester_cannot_approve"]);
  });

  test("someone else approving goes through", () => {
    const d = decideOperatorMerge(readiness, ci, undefined, {
      approver: "bo",
      requester: "ana",
      requesterCannotApprove: true,
    });
    expect(d.outcome).toBe("merge");
  });

  test("an unknown requester is refused when the rule is on, and ignored when it is off", () => {
    expect(
      decideOperatorMerge(readiness, ci, undefined, { approver: "bo", requesterCannotApprove: true }).outcome,
    ).toBe("refuse");
    expect(
      decideOperatorMerge(readiness, ci, undefined, {
        approver: "ana",
        requester: "ana",
        requesterCannotApprove: false,
      }).outcome,
    ).toBe("merge");
  });
});

class Fake extends GitHub {
  posted: string[] = [];
  merged: number[] = [];
  constructor(private readonly author: string) {
    super();
  }
  override async getIssue(): Promise<GhIssue> {
    return { number: 3, title: "t", body: "", labels: [], comments: [], author: this.author };
  }
  override async listOpenIssues(): Promise<GhIssue[]> {
    return [];
  }
  override async listIssuesByLabel() {
    return [];
  }
  override async listPrs(): Promise<GhPr[]> {
    return [];
  }
  override async commentIssue(_r: string, _n: number, body: string): Promise<number | undefined> {
    this.posted.push(body);
    return 1;
  }
  override async prForIssue(): Promise<GhPr | undefined> {
    return {
      number: 103,
      url: "u",
      state: "open",
      headRefName: "issue-3",
      isDraft: false,
      closingIssuesReferences: [{ number: 3 }],
    };
  }
  override async prStatus(): Promise<PrStatus> {
    return {
      state: "open",
      headRefOid: "sha1",
      closingIssuesReferences: [{ number: 3 }],
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
  }
  override async mergeReadiness(): Promise<MergeReadiness> {
    return readiness;
  }
  override async mergePr(_r: string, n: number): Promise<void> {
    this.merged.push(n);
  }
}

async function merge(author: string) {
  const cloneDir = mkdtempSync(join(scratch, "clone-"));
  mkdirSync(join(cloneDir, ".factory", "team"), { recursive: true });
  writeFileSync(join(cloneDir, ".factory", "config.json"), JSON.stringify({ repo: "acme/widgets" }));
  writeFileSync(
    join(cloneDir, ".factory", "team", "org.yml"),
    "name: org\npolicy:\n  approvals:\n    requester_cannot_approve: true\n",
  );
  const project = {
    cloneDir,
    config: { ...DEFAULT_CONFIG, repo: "acme/widgets" },
    machine: { slots: 1, runtimes: {} },
    leases: async () => [],
  } as unknown as DashboardProject;
  const github = new Fake(author);
  const state = new FactoryState(":memory:");
  const dashboard = createDashboard(state, github, "acme/widgets", false, scratch, undefined, undefined, project);
  const res = await dashboard.handle(
    new Request("http://localhost:4100/api/issues/3/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    "127.0.0.1",
  );
  return { res, github, dashboard };
}

describe("dashboard merge route", () => {
  test("a requester merging their own issue is refused, shown in the thread and the audit log", async () => {
    const { res, github, dashboard } = await merge("~local");
    expect(res.status).toBe(403);
    expect(github.merged).toEqual([]);
    expect(github.posted.join("\n")).toContain("requester_cannot_approve");
    const row = dashboard.access.store.audit()[0]!;
    expect([row.route, row.status, row.issue]).toEqual(["POST /api/issues/:n/merge", 403, 3]);
  });

  test("someone else's issue merges", async () => {
    const { res, github } = await merge("ana");
    expect(res.status).toBe(200);
    expect(github.merged).toEqual([103]);
  });
});
