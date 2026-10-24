// The PR body's Acceptance table (src/acceptance.ts). The fixture is real output of the kit's
// check-acceptance.py --json on a repo where AC-1 already held and AC-2 is new, so a change to the
// script's shape breaks this test rather than the table quietly.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCEPTANCE_SCRIPT, renderAcceptanceTable, runAcceptance, type AcceptanceVerdict } from "../src/acceptance";
import { mergeConfig } from "../src/config";
import { prBody, type WatchDeps } from "../src/engine/common";
import type { ExecutionPort } from "../src/ports/execution";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/acceptance.json"), "utf8"),
) as AcceptanceVerdict;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function exec(stdout: string, code = 0): ExecutionPort & { cmds: string[] } {
  const cmds: string[] = [];
  return {
    cmds,
    async run(cmd) {
      cmds.push(cmd);
      return { stdout, stderr: "", code };
    },
  };
}

function withScript(): string {
  const d = mkdtempSync(join(tmpdir(), "acceptance-"));
  dirs.push(d);
  mkdirSync(join(d, "scripts/lwp"), { recursive: true });
  writeFileSync(join(d, ACCEPTANCE_SCRIPT), "");
  return d;
}

describe("renderAcceptanceTable", () => {
  test("one row per criterion, each with its holdout and its proof", () => {
    const out = renderAcceptanceTable(fixture);
    expect(out).toContain("## Acceptance");
    expect(out).toContain(
      "| 07-pricing | AC-1: The yearly plan costs 297. | holdout/07-pricing/AC-1.sh | holds | pass |",
    );
    expect(out).toContain(
      "| 07-pricing | AC-2: The monthly plan costs 49 \\| billed monthly. | holdout/07-pricing/AC-2.sh | fails before, passes after | pass |",
    );
    expect(out).toContain("All 2 criteria proven.");
  });

  test("a holdout that already passed before the change is not proof", () => {
    const acs = fixture.acs.map((r) => (r.new ? { ...r, base: "pass" as const, ok: false } : r));
    const out = renderAcceptanceTable({ ...fixture, acs, errors: ["07-pricing AC-2: proves nothing"] });
    expect(out).toContain("| already passed before the change | FAIL |");
    expect(out).toContain("- 07-pricing AC-2: proves nothing");
    expect(out).toContain("Not proven: 1 of 2 criteria failed, 1 problem(s).");
  });

  test("a criterion with no holdout, or no criteria at all, is never shown as proven", () => {
    const bare = { ...fixture.acs[0]!, holdout: [], head: "fail" as const, ok: false };
    expect(renderAcceptanceTable({ ...fixture, acs: [bare] })).toContain("| none | no holdout | FAIL |");
    expect(renderAcceptanceTable({ base: null, acs: [], errors: [] })).toContain("Not proven: 0 of 0");
  });
});

describe("runAcceptance", () => {
  test("a repo without the kit script gets no table", async () => {
    const d = mkdtempSync(join(tmpdir(), "acceptance-"));
    dirs.push(d);
    const e = exec("{}");
    expect(await runAcceptance(e, d, "main")).toBeUndefined();
    expect(e.cmds).toEqual([]);
  });

  test("runs the script against the base branch and returns its verdict", async () => {
    const e = exec(JSON.stringify(fixture));
    expect(await runAcceptance(e, withScript(), "main")).toEqual(fixture);
    expect(e.cmds).toEqual([`python3 ${ACCEPTANCE_SCRIPT} --json --base 'origin/main'`]);
  });

  test("a crash with no JSON becomes a problem in the table, not a missing table", async () => {
    const v = await runAcceptance(exec("Traceback: boom", 1), withScript(), "main");
    expect(v?.acs).toEqual([]);
    expect(v?.errors[0]).toContain("exited 1 without a verdict: Traceback: boom");
  });
});

describe("prBody", () => {
  test("carries the table even when prRunSummary hides models and spend", () => {
    const config = mergeConfig({ repo: "o/r", prRunSummary: false });
    const body = prBody({} as WatchDeps, config, {} as never, "Closes #1", {} as never, undefined, fixture);
    expect(body.startsWith("Closes #1\n\n## Acceptance")).toBe(true);
    expect(prBody({} as WatchDeps, config, {} as never, "Closes #1", {} as never)).toBe("Closes #1");
  });
});
