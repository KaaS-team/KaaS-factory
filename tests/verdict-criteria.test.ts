// Plan criterion IDs reach the verify verdict: one the verdict leaves unmarked or unverified blocks a pass.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDir, type VerdictArtifact } from "../src/artifacts";
import { applyPlanCriteria, settleVerdict, verdictPost } from "../src/engine/verdict-rules";
import type { StepCtx } from "../src/engine/steps";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const pass = (criteria?: VerdictArtifact["criteria"]): VerdictArtifact => ({
  result: "pass",
  rounds: 1,
  findings: [],
  criteria,
});
const planned = [{ id: "AC-1" }, { id: "AC-2" }];

describe("applyPlanCriteria", () => {
  test("a plan criterion missing from the verdict is unverified and blocks the pass", () => {
    const out = applyPlanCriteria(pass([{ id: "AC-1", status: "pass" }]), planned);
    expect(out.result).toBe("uncertain");
    expect(out.criteria?.find((c) => c.id === "AC-2")?.status).toBe("unverified");
    expect(out.findings.length).toBe(1);
  });

  test("a verdict with no criteria at all blocks when the plan has some", () => {
    expect(applyPlanCriteria(pass(), planned).result).toBe("uncertain");
  });

  test("an unverified ID blocks too", () => {
    const out = applyPlanCriteria(
      pass([
        { id: "AC-1", status: "pass" },
        { id: "AC-2", status: "unverified" },
      ]),
      planned,
    );
    expect(out.result).toBe("uncertain");
  });

  test("every ID met keeps the pass; no plan criteria changes nothing", () => {
    const all = pass([
      { id: "AC-1", status: "pass" },
      { id: "AC-2", status: "pass" },
    ]);
    expect(applyPlanCriteria(all, planned)).toBe(all);
    const bare = pass();
    expect(applyPlanCriteria(bare, undefined)).toBe(bare);
  });

  test("a reject is left alone", () => {
    const r: VerdictArtifact = { result: "reject", rounds: 1, findings: [] };
    expect(applyPlanCriteria(r, planned)).toBe(r);
  });
});

describe("settleVerdict", () => {
  test("a plan.json criterion the verdict omits stops a pass in the real path", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const worktree = mkdtempSync(join(tmpdir(), "reqids-"));
    dirs.push(worktree);
    mkdirSync(join(worktree, runDir(7)), { recursive: true });
    writeFileSync(join(worktree, runDir(7), "plan.json"), JSON.stringify({ criteria: planned }));
    const sc = {
      worktree,
      config: { base: "main" },
      deps: { git: { changedFiles: async () => [] } },
      issue: { number: 7, comments: [] },
      ctx: {},
    } as unknown as StepCtx;
    const out = await settleVerdict(sc, pass([{ id: "AC-1", status: "pass" }]));
    expect(out.result).toBe("uncertain");
  });
});

describe("requirement ID table and unmatched IDs", () => {
  test("a verdict ID the plan does not have blocks the pass with its name in the reason", () => {
    const out = applyPlanCriteria(
      pass([
        { id: "AC-1", status: "pass" },
        { id: "AC-2", status: "pass" },
        { id: "AC-9", status: "pass" },
      ]),
      planned,
    );
    expect(out.result).toBe("uncertain");
    expect(JSON.stringify(out.findings)).toContain("the plan does not have: AC-9");
  });

  test("the posted verdict lists every ID with met, not met or unverified", () => {
    const body = verdictPost(
      "<!-- factory:verdict v1 -->\n## Verdict: uncertain\n\ntext",
      {
        result: "uncertain",
        rounds: 1,
        findings: [],
        criteria: [
          { id: "AC-1", status: "pass" },
          { id: "AC-2", status: "fail", gap: "no test" },
          { id: "AC-3", status: "unverified" },
        ],
      },
      1,
      3,
    );
    expect(body).toContain("| AC-1 | met |  |");
    expect(body).toContain("| AC-2 | not met | no test |");
    expect(body).toContain("| AC-3 | unverified |  |");
  });

  test("no criteria means no table", () => {
    expect(verdictPost("x", pass(), 1, 3).includes("Requirement IDs")).toBe(false);
  });
});
