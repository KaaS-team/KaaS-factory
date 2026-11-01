import { describe, expect, test } from "bun:test";
import { auditRepos, stuckJobs } from "../scripts/ci-baseline";

const wf = (label: string) => ({ path: ".github/workflows/ci.yml", content: `jobs:\n  a:\n    runs-on: ${label}\n` });

describe("ci-baseline", () => {
  test("a fake repo list: no CI and a bad label fail, a good repo passes", () => {
    const repos = [
      { repo: "kaas-team/none", workflows: [] },
      { repo: "kaas-team/auditor", workflows: [wf("kaas-gpu-box")] },
      { repo: "kaas-team/ok", workflows: [wf("ubuntu-latest")] },
    ];
    expect(auditRepos(repos)).toEqual([
      "kaas-team/none: no CI workflow",
      'kaas-team/auditor: .github/workflows/ci.yml uses runner label "kaas-gpu-box"',
    ]);
  });

  test("a list and an expression are read", () => {
    expect(auditRepos([{ repo: "r", workflows: [wf("[self-hosted, nope]")] }])).toEqual([
      'r: .github/workflows/ci.yml uses runner label "nope"',
    ]);
    expect(auditRepos([{ repo: "r", workflows: [wf("${{ matrix.os }}")] }])).toEqual([]);
  });

  test("a job queued over 10 minutes is flagged, 10 is not", () => {
    const now = new Date("2026-10-31T12:00:00Z");
    const jobs = [
      { repo: "a", job: "old", queuedAt: "2026-10-31T11:02:00Z" },
      { repo: "a", job: "edge", queuedAt: "2026-10-31T11:50:00Z" },
    ];
    expect(stuckJobs(jobs, now)).toEqual(['a: job "old" queued 58 minutes']);
  });
});
