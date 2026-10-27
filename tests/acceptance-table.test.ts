// The PR body's Acceptance table (src/acceptance.ts). The fixture is real output of the kit's
// check-acceptance.py --json on a repo where AC-1 already held and AC-2 is new, so a change to the
// script's shape breaks this test rather than the table quietly. Also: an unproven verdict rejects
// verify, and the kit's holdout folder joins the paths no stage may see.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCEPTANCE_SCRIPT,
  acceptanceProven,
  hiddenPaths,
  planAcceptance,
  renderAcceptanceTable,
  runAcceptance,
  type AcceptanceVerdict,
} from "../src/acceptance";
import { CommandExecutor } from "../src/agents/executor";
import { mergeConfig } from "../src/config";
import type { WatchDeps } from "../src/engine/common";
import { prBody, renderWhatChanged } from "../src/engine/pr-body";
import type { StageName } from "../src/executor";
import { LABEL } from "../src/labels";
import type { ExecutionPort } from "../src/ports/execution";
import { FactoryState } from "../src/state";
import { advanceIssue } from "../src/watch";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

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
  mkdirSync(join(d, "scripts/kaas"), { recursive: true });
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

describe("planAcceptance", () => {
  const row = (spec: string, ac: string) => ({ ...fixture.acs[0]!, spec, ac });
  const twoAcs = { criteria: [{ id: "AC-1" }, { id: "AC-2" }] };

  test("a plan with two ACs gets exactly those two rows", () => {
    const kit = { ...fixture, acs: [row("s", "AC-1"), row("s", "AC-2"), row("s", "AC-3")], errors: ["s AC-3: bad"] };
    const out = planAcceptance(kit, twoAcs)!;
    expect(out.acs.map((r) => r.ac)).toEqual(["AC-1", "AC-2"]);
    expect(out.errors).toEqual([]);
    expect(renderAcceptanceTable(out)).not.toContain("AC-3");
  });

  test("another spec's AC with the same id is left out", () => {
    const kit = { ...fixture, acs: [row("07-pricing", "AC-1"), row("03-presigned-downloads", "AC-1")], errors: [] };
    const out = planAcceptance(kit, { ...twoAcs, spec: "07-pricing" })!;
    expect(out.acs.map((r) => r.spec)).toEqual(["07-pricing"]);
  });

  test("no criteria keeps the kit verdict, no match means no verdict", () => {
    expect(planAcceptance(fixture, {})).toBe(fixture);
    const other = { ...fixture, acs: [row("s", "AC-9")], errors: [] };
    expect(planAcceptance(other, twoAcs)).toBeUndefined();
    const crashed = { base: null, acs: [], errors: ["check-acceptance exited 1 without a verdict: boom"] };
    expect(planAcceptance(crashed, twoAcs)?.errors).toHaveLength(1);
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
    const acceptance = renderAcceptanceTable(fixture);
    const body = prBody({} as WatchDeps, config, {} as never, "Closes #1", {} as never, { acceptance });
    expect(body.startsWith("Closes #1\n\n## Acceptance")).toBe(true);
    expect(prBody({} as WatchDeps, config, {} as never, "Closes #1", {} as never)).toBe("Closes #1");
  });
});

// Answers each command by the first key it contains; anything else exits 1.
function scripted(answers: Record<string, string | (() => string)>): ExecutionPort & { cmds: string[] } {
  const cmds: string[] = [];
  return {
    cmds,
    async run(cmd) {
      cmds.push(cmd);
      const key = Object.keys(answers).find((k) => cmd.includes(k));
      if (key === undefined) return { stdout: "", stderr: "", code: 1 };
      const a = answers[key]!;
      return { stdout: typeof a === "string" ? a : a(), stderr: "", code: 0 };
    },
  };
}

describe("hiddenPaths", () => {
  const config = mergeConfig({ repo: "o/r", holdout: { paths: ["qa/**"], cmd: "bun test qa" } });

  test("adds the kit's holdout folder, read from the base branch's repo.json, never the worktree's", async () => {
    const e = scripted({
      "cat-file": "",
      ".agents/repo.json": JSON.stringify({ acceptance: { specs: ["specs/*.md"], holdout: "checks/", run: "x" } }),
    });
    expect(await hiddenPaths(e, config, "/w")).toEqual(["qa/**", "checks/**"]);
    expect(e.cmds).toContain(`git show 'origin/main':.agents/repo.json`);
  });

  test("the folder defaults to holdout, and .claude/repo.json is read when .agents has none", async () => {
    const e = scripted({
      "cat-file": "",
      ".claude/repo.json": JSON.stringify({ acceptance: { specs: [], run: "x" } }),
    });
    expect(await hiddenPaths(e, config, "/w")).toEqual(["qa/**", "holdout/**"]);
  });

  test("without the kit script on the base branch only config.holdout.paths are hidden", async () => {
    expect(await hiddenPaths(scripted({}), config, "/w")).toEqual(["qa/**"]);
    expect(await hiddenPaths(scripted({}), mergeConfig({ repo: "o/r" }), "/w")).toEqual([]);
  });
});

describe("an unproven acceptance verdict rejects verify", () => {
  const dirs2: string[] = [];
  afterAll(() => {
    for (const d of dirs2) rmSync(d, { recursive: true, force: true });
  });

  // Drives one issue from ready to a shipped PR, check-acceptance.py answering with each verdict in turn.
  async function ship(verdicts: AcceptanceVerdict[], plan: Record<string, unknown>, changed: string[] = []) {
    const n = 1;
    const workspacesDir = mkdtempSync(join(tmpdir(), "factory-accept-ws-"));
    const cloneDir = mkdtempSync(join(tmpdir(), "factory-accept-clone-"));
    dirs2.push(workspacesDir, cloneDir);
    mkdirSync(join(workspacesDir, `issue-${n}`, "scripts/kaas"), { recursive: true });
    writeFileSync(join(workspacesDir, `issue-${n}`, ACCEPTANCE_SCRIPT), "");
    const setupRunner = scripted({ "--json": () => JSON.stringify(verdicts.shift()) });
    const github = new FakeGitHub([baseIssue(n, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const executor = new MultiStageExecutor();
    const git = new FakeGit();
    git.changed = changed;
    const deps = {
      github,
      git,
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      setupRunner,
      cloneDir,
      workspacesDir,
    };
    const config = mergeConfig({ repo: "acme/widgets" });
    const push = (stage: StageName, files: Record<string, string>) =>
      executor.push(stage, n, fixtureFor(stage, n), files);
    push("triage", {
      "triage-comment.md": "<!-- factory:triage v1 -->\ntriage",
      "triage.json": JSON.stringify({
        disposition: "proceed",
        type: "bug",
        risk: "low",
        done_when: "x",
        files_expected: ["src/a.ts"],
        gate_level: "make check",
        confidence: 0.9,
      }),
    });
    push("plan", {
      "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
      "plan.json": JSON.stringify({
        risk: "low",
        revision: 1,
        files: ["src/a.ts"],
        autoApproveEligible: true,
        ...plan,
      }),
    });
    const built = { "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }) };
    for (const _ of verdicts) push("build", built);
    push("verify", {
      "verdict-comment.md": "<!-- factory:verdict v1 -->\nverdict",
      "verdict.json": JSON.stringify({
        result: "pass",
        rounds: 1,
        findings: [],
        criteria: [{ id: "AC-1", status: "pass" }],
      }),
    });
    push("pr", { "pr-body.md": "Did it.\nCloses #1" });
    expect(await advanceIssue(deps, config, github.issues.get(n)!)).toBe("shipped");
    return { github, setupRunner, body: github.createdPrs[0]!.body };
  }

  test("the build is sent back with the table, and a proven retry ships", async () => {
    const unproven = {
      ...fixture,
      acs: fixture.acs.map((r) => (r.new ? { ...r, head: "fail" as const, ok: false } : r)),
    };
    const { github, setupRunner } = await ship([unproven, fixture], {});
    const comments = github.issues.get(1)!.comments.map((c) => c.body);
    expect(comments.some((b) => b.includes("## Acceptance") && b.includes("Not proven: 1 of 2"))).toBe(true);
    expect(setupRunner.cmds.filter((c) => c.includes("--json"))).toHaveLength(2);
  });

  // #90: the kit checks every spec in the repo, and its whole table once became a PR's Acceptance.
  test("the PR body names only this issue's own criteria, never another spec's", async () => {
    const other = {
      ...fixture.acs[0]!,
      spec: "03-presigned-downloads",
      text: "A presigned GET reproduces the signature.",
    };
    const plan = {
      goal: "Monthly plan shows its price.",
      spec: "07-pricing",
      criteria: [{ id: "AC-1", text: "The pricing page shows 49 a month." }],
    };
    const { body } = await ship([{ ...fixture, acs: [...fixture.acs, other] }], plan, ["src/a.ts"]);
    const acceptance = body.slice(body.indexOf("## Acceptance"));
    expect(acceptance).toContain("| AC-1: The pricing page shows 49 a month. | pass |");
    expect(acceptance).toContain("### Holdouts for 07-pricing");
    expect(acceptance).toContain("| 07-pricing | AC-2: The monthly plan costs 49");
    expect(body).not.toContain("presigned");
    expect(acceptance).toContain("All 2 criteria proven.");
  });

  test("the PR body opens with What changed, built from the plan and the diff", async () => {
    const plan = { goal: "Monthly plan shows its price.", criteria: [{ id: "AC-1", text: "Shows 49." }] };
    const { body } = await ship([fixture], plan, ["src/a.ts", "tests/a.test.ts"]);
    expect(body.startsWith("## What changed\n\nMonthly plan shows its price.\n")).toBe(true);
    expect(body).toContain("- Files: `src/a.ts`, `tests/a.test.ts`");
    expect(body.indexOf("Did it.")).toBeGreaterThan(body.indexOf("- Fails without it:"));
    // A plan that names no spec shows none of the kit's rows.
    expect(body).not.toContain("| 07-pricing |");
    expect(body.lastIndexOf("## ")).toBe(body.indexOf("## Factory run"));
  });

  test("What changed names the test that fails without the change, or says none was shown", () => {
    const proof = { status: "bites" as const, reverted: ["src/a.ts"], tests: ["tests/a.test.ts"], cmd: "x", tail: "" };
    expect(renderWhatChanged("Goal.", ["src/a.ts"], proof)).toBe(
      "## What changed\n\nGoal.\n\n- Files: `src/a.ts`\n- Fails without it: `tests/a.test.ts`, red with `src/a.ts` reverted",
    );
    expect(renderWhatChanged("Goal.", [], { ...proof, status: "passes-without" })).toContain(
      "- Fails without it: no test shown (proof passes-without)",
    );
  });

  test("verify's table lists only the plan's criteria", async () => {
    const stray = { ...fixture.acs[0]!, ac: "AC-3", text: "An unrelated criterion.", head: "fail" as const, ok: false };
    const failing = { ...fixture.acs[1]!, head: "fail" as const, ok: false };
    const plan = {
      criteria: [
        { id: "AC-1", text: "one" },
        { id: "AC-2", text: "two" },
      ],
    };
    const first = await ship([{ ...fixture, acs: [fixture.acs[0]!, failing, stray] }, fixture], plan);
    const tables = first.github.issues
      .get(1)!
      .comments.map((c) => c.body)
      .filter((b) => b.includes("Not proven"));
    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain("Not proven: 1 of 2 criteria failed");
    expect(tables[0]).toContain("AC-2");
    expect(tables[0]).not.toContain("AC-3");
    // A failing row outside the plan neither posts a table nor rejects.
    const second = await ship([{ ...fixture, acs: [...fixture.acs, stray] }], plan);
    expect(second.setupRunner.cmds.filter((c) => c.includes("--json"))).toHaveLength(1);
  });

  test("proven means every row ok, no errors, and at least one criterion", () => {
    expect(acceptanceProven(fixture)).toBe(true);
    expect(acceptanceProven({ ...fixture, errors: ["x"] })).toBe(false);
    expect(acceptanceProven({ base: null, acs: [], errors: [] })).toBe(false);
  });
});

test("the stage's agent is handed the hidden paths, for guard-paths.sh", async () => {
  const d = mkdtempSync(join(tmpdir(), "acceptance-env-"));
  dirs.push(d);
  mkdirSync(join(d, ".claude/skills/factory-plan"), { recursive: true });
  writeFileSync(join(d, ".claude/skills/factory-plan/SKILL.md"), "---\nname: factory-plan\n---\nPlan it.\n");
  const executor = new CommandExecutor(
    {
      x: {
        command: [
          "sh",
          "-c",
          'cat >/dev/null; printf %s "$FACTORY_HIDDEN_PATHS" > "$FACTORY_ARTIFACT_DIR/hidden.txt"',
          "agent",
        ],
      },
    },
    { default: "x" },
  );
  await executor.runStage({ stage: "plan", issue: 7, cwd: d, maxBudgetUsd: 1, hiddenPaths: ["holdout/**", "qa/**"] });
  expect(readFileSync(join(d, ".factory/runs/issue-7/hidden.txt"), "utf8")).toBe("holdout/**\nqa/**");
});
