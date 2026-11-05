import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciBaselineChecks } from "../src/ci-baseline-check";

const call = "KaaS-team/KaaS-factory/.github/workflows/ci-baseline.yml@main";
const wf = (body: string) => [{ path: ".github/workflows/ci.yml", content: body }];

describe("doctor: shared CI baseline", () => {
  test("a repo that calls the baseline passes", () => {
    const rows = ciBaselineChecks("KaaS-team/app", wf(`on: push\njobs:\n  baseline:\n    uses: ${call}\n`));
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  test("a repo that does not call it fails and names the missing check", () => {
    const rows = ciBaselineChecks("KaaS-team/app", wf("on: push\njobs:\n  own:\n    runs-on: ubuntu-latest\n"));
    expect(rows.filter((r) => !r.ok).map((r) => r.name)).toEqual(["ci baseline: called"]);
  });

  test("a repo whose call is skipped or allowed to fail fails and names the drift", () => {
    const skipped = ciBaselineChecks("KaaS-team/app", wf(`on: push\njobs:\n  b:\n    if: false\n    uses: ${call}\n`));
    expect(skipped[0]).toMatchObject({ name: "ci baseline: not drifted", ok: false });
    expect(skipped[0]!.detail).toContain("skipped");
    const lax = ciBaselineChecks(
      "KaaS-team/app",
      wf(`on: push\njobs:\n  b:\n    continue-on-error: true\n    uses: ${call}\n`),
    );
    expect(lax[0]!.ok).toBe(false);
    expect(lax[0]!.detail).toContain("continue-on-error");
  });

  test("a repo outside KaaS-team is not checked", () => {
    expect(ciBaselineChecks("someone/else", [])).toEqual([]);
  });

  test("the staged reusable workflow is callable and runs the gate", () => {
    const text = readFileSync(join(import.meta.dir, "../.github/workflows/ci-baseline.yml"), "utf8");
    const doc = Bun.YAML.parse(text) as {
      on: { workflow_call: unknown };
      jobs: Record<string, { steps: { run?: string }[] }>;
    };
    expect("workflow_call" in doc.on).toBe(true);
    expect(Object.values(doc.jobs).some((j) => j.steps.some((s) => s.run === "make check"))).toBe(true);
  });
});
