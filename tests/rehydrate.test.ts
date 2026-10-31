// Rebuilds `.factory/runs/issue-N/*` from the issue thread alone — the piece
// that makes an issue resumable from a machine that has never seen it
// before (a fresh clone, a fresh CI job, a `factory retry` after the
// workspace was wiped). Round trip: post the comments the runner would have
// posted, then check rehydrate recovers exactly what a stage would have
// left on disk.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir } from "../src/artifacts";
import type { GhComment, GhIssue } from "../src/github";
import { rehydrate } from "../src/rehydrate";

function comment(body: string, id: number): GhComment {
  return { id, author: "factory-bot", authorAssociation: "NONE", body, createdAt: "2026-01-01T00:00:00Z" };
}

function dataMarker(stage: string, json: unknown): string {
  return `<!-- factory:data ${JSON.stringify({ stage, json })} -->`;
}

describe("rehydrate", () => {
  test("recovers every earlier stage's comment and json from the thread", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-rehydrate-"));
    const triageJson = {
      disposition: "proceed",
      type: "bug",
      risk: "low",
      done_when: "x",
      files_expected: [],
      gate_level: "make check",
      confidence: 0.9,
    };
    const planJson = { risk: "low", revision: 1, files: ["src/a.ts"], autoApproveEligible: true };
    const buildJson = { status: "green", gate_line: "make check: 10 pass", rounds: 1 };
    const verdictJson = { result: "pass", rounds: 1, findings: [] };

    const issue: GhIssue = {
      number: 9,
      title: "Fix the thing",
      body: "do it",
      labels: [{ name: "factory:in-review" }],
      comments: [
        comment(`<!-- factory:triage v1 -->\nLooks like a real bug.\n\n${dataMarker("triage", triageJson)}`, 1),
        comment(`<!-- factory:plan v1 rev=1 -->\nHere's the plan.\n\n${dataMarker("plan", planJson)}`, 2),
        // The build status comment is edited in place; only its JSON needs
        // to be recoverable, not a comment file.
        comment(`<!-- factory:status v1 -->\nbuilding...\n\n${dataMarker("build", buildJson)}`, 3),
        comment(`<!-- factory:verdict v1 -->\nShips it.\n\n${dataMarker("verify", verdictJson)}`, 4),
      ],
    };

    await rehydrate(worktree, issue);
    const dir = `${worktree}/${runDir(9)}`;

    expect(await Bun.file(`${dir}/triage-comment.md`).text()).toBe(
      "<!-- factory:triage v1 -->\nLooks like a real bug.",
    );
    expect(await Bun.file(`${dir}/triage.json`).json()).toEqual(triageJson);

    expect(await Bun.file(`${dir}/plan-comment.md`).text()).toBe("<!-- factory:plan v1 rev=1 -->\nHere's the plan.");
    expect(await Bun.file(`${dir}/plan.json`).json()).toEqual(planJson);

    // Build never gets a recovered comment file (see comment above) — only json.
    expect(await Bun.file(`${dir}/status-comment.md`).exists()).toBe(false);
    expect(await Bun.file(`${dir}/build.json`).json()).toEqual(buildJson);

    expect(await Bun.file(`${dir}/verdict-comment.md`).text()).toBe("<!-- factory:verdict v1 -->\nShips it.");
    expect(await Bun.file(`${dir}/verdict.json`).json()).toEqual(verdictJson);

    rmSync(worktree, { recursive: true, force: true });
  });

  test("recovers only the latest marker when a stage ran more than once (reject-and-rebuild)", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-rehydrate-"));
    const issue: GhIssue = {
      number: 3,
      title: "t",
      body: "b",
      labels: [{ name: "factory:building" }],
      comments: [
        comment(
          `<!-- factory:verdict v1 -->\nfirst reject\n\n${dataMarker("verify", { result: "reject", rounds: 1, findings: ["a"] })}`,
          1,
        ),
        comment(
          `<!-- factory:verdict v1 -->\nsecond reject\n\n${dataMarker("verify", { result: "reject", rounds: 2, findings: ["b"] })}`,
          2,
        ),
      ],
    };
    await rehydrate(worktree, issue);
    const dir = `${worktree}/${runDir(3)}`;
    expect(await Bun.file(`${dir}/verdict.json`).json()).toEqual({ result: "reject", rounds: 2, findings: ["b"] });
    expect(await Bun.file(`${dir}/verdict-comment.md`).text()).toBe("<!-- factory:verdict v1 -->\nsecond reject");
    rmSync(worktree, { recursive: true, force: true });
  });

  test("a graded build comment ({ build, gate }) rehydrates to the build object alone", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-rehydrate-"));
    const build = { status: "green", gate_line: "x", rounds: 1 };
    const issue: GhIssue = {
      number: 5,
      title: "t",
      body: "b",
      labels: [{ name: "factory:verifying" }],
      comments: [
        comment(`<!-- factory:status v1 -->\nbuilt\n\n${dataMarker("build", { build, gate: { status: "GREEN" } })}`, 1),
      ],
    };
    await rehydrate(worktree, issue);
    expect(await Bun.file(`${worktree}/${runDir(5)}/build.json`).json()).toEqual(build);
    rmSync(worktree, { recursive: true, force: true });
  });

  test("a stage with no marker yet writes nothing for it, without throwing", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-rehydrate-"));
    const issue: GhIssue = { number: 4, title: "t", body: "b", labels: [{ name: "factory:triaging" }], comments: [] };
    await rehydrate(worktree, issue);
    const dir = `${worktree}/${runDir(4)}`;
    expect(await Bun.file(`${dir}/triage.json`).exists()).toBe(false);
    expect(await Bun.file(`${dir}/triage-comment.md`).exists()).toBe(false);
    rmSync(worktree, { recursive: true, force: true });
  });
});

describe("rehydrate: prior findings and operator answers", () => {
  const trusted = (body: string, id: number): GhComment => ({ ...comment(body, id), authorAssociation: "OWNER" });
  const verdict = (json: object, id: number) =>
    comment(`<!-- factory:verdict v1 -->\n${dataMarker("verify", json)}`, id);
  async function run(comments: GhComment[], seed?: string) {
    const worktree = mkdtempSync(join(tmpdir(), "factory-rehydrate-"));
    if (seed) {
      mkdirSync(join(worktree, runDir(5)), { recursive: true });
      writeFileSync(join(worktree, runDir(5), "prior-findings.json"), seed);
    }
    await rehydrate(worktree, { number: 5, title: "t", body: "", labels: [], comments });
    const out = new Map<string, string>();
    for (const n of ["prior-findings.json", "operator-answers.md"]) {
      const f = join(worktree, runDir(5), n);
      if (existsSync(f)) out.set(n, readFileSync(f, "utf8"));
    }
    rmSync(worktree, { recursive: true, force: true });
    return (n: string) => out.get(n);
  }
  const reject = {
    result: "reject",
    rounds: 1,
    findings: [
      "plain",
      { severity: "must", confidence: 4, what: "m" },
      { severity: "should", confidence: 4, what: "s" },
    ],
  };

  test("a last reject writes its must findings only", async () => {
    const read = await run([verdict(reject, 1)]);
    expect(JSON.parse(read("prior-findings.json")!)).toEqual(["plain", "m"]);
  });
  test("a last pass, or a holdout-only marker after it, writes none", async () => {
    const pass = verdict({ result: "pass", rounds: 2, findings: [] }, 2);
    expect(await run([verdict(reject, 1), pass])).toBeDefined();
    expect((await run([verdict(reject, 1), pass]))("prior-findings.json")).toBeUndefined();
    const holdout = comment(`<!-- factory:holdout -->\n${dataMarker("verify", { acceptance: [] })}`, 3);
    expect((await run([verdict(reject, 1), pass, holdout]))("prior-findings.json")).toBeUndefined();
  });
  test("an existing prior-findings.json is left alone", async () => {
    expect((await run([verdict(reject, 1)], '["kept"]'))("prior-findings.json")).toBe('["kept"]');
  });
  test("trusted plain comments become operator-answers.md; commands, runner and untrusted ones do not", async () => {
    const read = await run([
      trusted("use the v2 API", 1),
      trusted("/factory retry", 2),
      trusted("<!-- factory:status v1 -->\nrunner", 3),
      comment("drive-by", 4),
      trusted("and keep it small", 5),
    ]);
    expect(read("operator-answers.md")).toBe("use the v2 API\n\n---\n\nand keep it small\n");
    expect((await run([comment("drive-by", 1)]))("operator-answers.md")).toBeUndefined();
  });
});
