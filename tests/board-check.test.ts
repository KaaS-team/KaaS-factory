import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoardIssue, checkBoard, PLANNED_LABEL, type Rule } from "../scripts/board-check";
import { PLANNED_MARKER } from "../src/engine/import-plan";
import { LABEL } from "../src/labels";

const plan = await Bun.file(`${import.meta.dir}/fixtures/planned-issue.md`).text();
const SPEC = "## Problem\nx\n\n## Acceptance\n- y\n\n## Out of scope\n- z\n";

let n = 0;
const issue = (o: Partial<BoardIssue> = {}): BoardIssue => ({
  number: ++n,
  state: "open",
  title: "t",
  body: SPEC,
  labels: [],
  milestone: "v1",
  subIssues: [],
  ...o,
});
const rules = (issues: BoardIssue[]): Rule[] => checkBoard(issues).map((f) => f.rule);

// One passing and one failing case per rule; a passing board raises nothing.
describe("board-check rules", () => {
  test("a complete spec with a milestone passes", () => {
    expect(checkBoard([issue()])).toEqual([]);
  });

  test("sections: a missing Problem, Acceptance or Out of scope fails", () => {
    for (const s of ["Problem", "Acceptance", "Out of scope"]) {
      const body = SPEC.replace(`## ${s}`, "## Other");
      const f = checkBoard([issue({ body })]);
      expect(f.map((x) => x.message)).toEqual([`no ${s} section`]);
    }
  });

  test("sections: a ledger issue and a closed issue are not checked", () => {
    expect(checkBoard([issue({ body: "", labels: [LABEL.ledger] }), issue({ body: "", state: "closed" })])).toEqual([]);
  });

  test("plan-marker: a valid planned body passes", () => {
    expect(plan.startsWith(PLANNED_MARKER)).toBe(true);
    expect(checkBoard([issue({ body: plan, labels: [PLANNED_LABEL] })])).toEqual([]);
  });

  test("plan-marker: the marker without a parsable plan fails", () => {
    expect(rules([issue({ body: `${PLANNED_MARKER}\n${SPEC}` })])).toEqual(["plan-marker"]);
  });

  test("plan-marker: the label without a plan fails", () => {
    expect(rules([issue({ labels: [PLANNED_LABEL] })])).toEqual(["plan-marker"]);
  });

  test("epic-children: open native children pass", () => {
    const a = issue();
    expect(checkBoard([issue({ labels: ["epic"], subIssues: [a.number] }), a])).toEqual([]);
  });

  test("epic-children: a closed child fails", () => {
    const a = issue({ state: "closed" });
    const e = issue({ labels: ["epic"], subIssues: [a.number] });
    expect(checkBoard([e, a]).map((f) => f.message)).toEqual([`child #${a.number} is closed`]);
  });

  test("epic-children: a missing child fails, from native sub-issues and from the checklist", () => {
    const a = issue();
    const e = issue({ labels: ["epic"], subIssues: [a.number, 99990], body: `${SPEC}\n- [ ] #99991\n` });
    expect(checkBoard([e, a]).map((f) => f.message)).toEqual([
      "child #99990 does not exist",
      "child #99991 does not exist",
    ]);
  });

  test("epic-children: the body checklist is not the source of truth", () => {
    const a = issue();
    const e = issue({ labels: ["epic"], subIssues: [], body: `${SPEC}\n- [ ] #${a.number}\n` });
    expect(rules([e, a])).toEqual(["epic-children"]);
  });

  test("milestone: none fails unless a ledger or labelled later", () => {
    expect(rules([issue({ milestone: null })])).toEqual(["milestone"]);
    expect(checkBoard([issue({ milestone: null, labels: ["later"] })])).toEqual([]);
    expect(checkBoard([issue({ milestone: null, labels: [LABEL.ledger] })])).toEqual([]);
  });
});

describe("board-check cli", () => {
  const run = (args: string[], board: BoardIssue[]) => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "board-check-"));
    const f = join(dir, "board.json");
    writeFileSync(f, JSON.stringify(board));
    try {
      return Bun.spawnSync(["bun", "scripts/board-check.ts", "--file", f, ...args], {
        timeout: 60_000,
        cwd: `${import.meta.dir}/..`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const bad = [issue({ milestone: null })];

  test("report-only exits 0 on a finding and names it", () => {
    const p = run([], bad);
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain("[milestone] no milestone");
  });

  test("--required exits 1 on a finding and 0 on a clean board", () => {
    expect(run(["--required"], bad).exitCode).toBe(1);
    expect(run(["--required"], [issue()]).exitCode).toBe(0);
  });
});
