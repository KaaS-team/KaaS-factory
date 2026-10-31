import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problems } from "../scripts/check-pr-body";

const template = readFileSync(".github/pull_request_template.md", "utf8");
const filled = (over: Record<string, string> = {}): string => {
  const sec: Record<string, string> = {
    Summary: "One thing changed.\n\nCloses #12",
    Plan: "Planned in #12.",
    "Gate evidence": "make check: 412 pass, 0 fail",
    "Verify verdict": "AC-1 pass",
    Confidence: "| Gate | make check green |",
    "Risk and rollback": "Low; revert the commit.",
    ...over,
  };
  return Object.entries(sec)
    .map(([k, v]) => `## ${k}\n\n${v}\n`)
    .join("\n");
};

describe("check-pr-body", () => {
  test("a body with every template section passes", () => {
    expect(problems(filled(), template)).toEqual([]);
  });
  test("a one-paragraph body is refused with every missing section named", () => {
    const out = problems("check-mutations was red.", template);
    expect(out).toHaveLength(6);
    expect(out[0]).toContain('missing section "Summary"');
  });
  test("the template has a Confidence section with the five layer rows", () => {
    const section = template.split("## Confidence")[1]!.split("\n## ")[0]!;
    for (const layer of [
      "Gate",
      "Proof (fails on base)",
      "Changed-line mutants",
      "Review findings with evidence",
      "UI preview and smoke",
    ])
      expect(section).toContain(`| ${layer} |`);
  });
  test("an empty or comment-only section is refused", () => {
    expect(problems(filled({ "Gate evidence": "<!-- verbatim -->" }), template)).toEqual([
      'section "Gate evidence" is empty',
    ]);
  });
  test("a Summary holding only a bare Closes line is refused", () => {
    expect(problems(filled({ Summary: "Closes #" }), template)).toEqual(['section "Summary" is empty']);
  });
  test.each(["Pending CI", "pending", "TBD", "TODO", "N/A", "n/a", "NA", "pass", "Passed.", "OK", "None"])(
    "the placeholder verdict %p is refused",
    (verdict) => {
      expect(problems(filled({ "Verify verdict": verdict }), template)).toEqual([
        'section "Verify verdict" is a placeholder',
      ]);
    },
  );
  test("a real verdict is accepted", () => {
    const verdict = "Pass: 412 tests, 0 failures, mutations 3/3 red";
    expect(problems(filled({ "Verify verdict": verdict }), template)).toEqual([]);
  });
  test("gate evidence with prose and no digit is refused", () => {
    expect(problems(filled({ "Gate evidence": "make check passed" }), template)).toEqual([
      'section "Gate evidence" has no output',
    ]);
  });
  test("gate evidence in a fenced block is accepted", () => {
    expect(problems(filled({ "Gate evidence": "```\nmake check: ok\n```" }), template)).toEqual([]);
  });
  test("the factory's own shape passes", () => {
    const body =
      "## What changed\n\nGoal.\n\n## Acceptance\n\n| a | pass |\n\n## Verify verdict\n\nPending\n\nThe receipt is in the run-details comment on #7.";
    expect(problems(body, template)).toEqual([]);
  });
  test("a session link is refused in either shape", () => {
    expect(problems(`${filled()}\nhttps://claude.ai/code/session_x`, template)).toEqual([
      "the body links a Claude session",
    ]);
  });
});

describe("check-pr-body --file", () => {
  const run = (body: string, env: Record<string, string> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "prbody-"));
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    const args = ["bun", "scripts/check-pr-body.ts", ...(env.PR_BODY === undefined ? ["--file", file] : [])];
    return Bun.spawnSync(args, { env: { ...process.env, ...env } });
  };
  test("a placeholder verdict exits 1 with the placeholder message", () => {
    const r = run(filled({ "Verify verdict": "Pending CI" }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('section "Verify verdict" is a placeholder');
  });
  test("a complete body exits 0", () => {
    expect(run(filled()).exitCode).toBe(0);
  });
  test("PR_BODY still works", () => {
    expect(run("", { PR_BODY: filled() }).exitCode).toBe(0);
    expect(run("", { PR_BODY: "short" }).exitCode).toBe(1);
  });
});
