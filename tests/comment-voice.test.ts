import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commentProblems, openingLine, stripOperatorDetail } from "../src/comment-voice";

const ASSETS = join(import.meta.dir, "..", "template", ".claude", "skills", "factory-comment", "assets");
const TEMPLATES = ["triage", "question", "plan", "status", "verdict"] as const;

// One filled comment per template, written the way the skill tells a stage to write it.
const FIXTURES: Record<(typeof TEMPLATES)[number], string> = {
  triage: `<!-- factory:triage v1 -->
This is a small bug fix, so I will plan it next.

## Triage

This looks like a bug (low risk), and I am fairly sure about that.

Disposition: proceed.
`,
  question: `<!-- factory:question v1 -->
I need an answer to one question before I can continue, and then I will pick the work back up.

**1. Which date format do you want?**
- **a.** ISO dates.
- **b.** Local dates.
I suggest **a**. If you don't reply, I will do this:
Use ISO dates.
`,
  plan: `<!-- factory:plan v1 rev=1 -->
I plan to fix the date parser, and I am waiting for your approval before I start.

## Plan (rev 1)

The goal is to parse dates with a zone.
- Dates with a zone parse. I will check it with \`make test\`.
`,
  status: `<!-- factory:status v1 -->
The build has finished and verification starts next.

I am on step 3 of 5, build, and it has taken 4 minutes so far.
`,
  verdict: `<!-- factory:verdict v1 -->
The build passes verification, so a draft pull request comes next.

### What I found for each criterion
- Dates with a zone parse. It passes: \`make test\` was green.
`,
};

function fill(template: string): string {
  return template
    .split("\n")
    .filter((l) => !/^\{\{[#/]/.test(l.trim()) && l.trim() !== "{{else}}")
    .join("\n")
    .replace(/\{\{one_sentence_[a-z_]+\}\}/g, "Something happened and a next step follows.")
    .replace(/\{\{[^}]+\}\}/g, "text");
}

describe("every template opens with a plain sentence", () => {
  for (const name of TEMPLATES) {
    test(`${name}.md opens with a sentence once filled`, () => {
      const text = readFileSync(join(ASSETS, `${name}.md`), "utf8");
      expect(openingLine(text).startsWith("**")).toBe(false);
      expect(commentProblems(fill(text))).toEqual([]);
    });

    test(`${name} fixture comment passes the checker`, () => {
      expect(commentProblems(FIXTURES[name])).toEqual([]);
    });
  }
});

describe("commentProblems rejects", () => {
  const ok = "<!-- factory:status v1 -->\nThe build finished and verify is next.\n";
  test("a comment with no opening sentence", () => {
    expect(commentProblems("<!-- factory:triage v1 -->\n## Triage\n\n**Disposition:** proceed\n")).toEqual([
      "opens with something other than one plain sentence",
    ]);
    expect(commentProblems("<!-- factory:status v1 -->\n- a bullet.\n")).toEqual([
      "opens with something other than one plain sentence",
    ]);
    expect(commentProblems("Disposition: proceed.\n")).toEqual(["opens with something other than one plain sentence"]);
    expect(commentProblems("")).toEqual(["opens with something other than one plain sentence"]);
  });
  test("a model id", () => {
    expect(commentProblems(`${ok}Built by claude-sonnet-5-5.\n`)).toEqual(["names a model"]);
    expect(commentProblems(`${ok}Reviewed with Opus 5.5.\n`)).toEqual(["names a model"]);
  });
  test("a dollar amount", () => {
    expect(commentProblems(`${ok}It cost $1.20.\n`)).toEqual(["shows a dollar amount"]);
  });
  test("a run id", () => {
    expect(commentProblems(`${ok}See run-a1b2c3d4 for logs.\n`)).toEqual(["shows a run id"]);
    expect(commentProblems(`${ok}The run id is missing.\n`)).toEqual(["shows a run id"]);
    expect(commentProblems(`${ok}Run 123e4567-e89b-12d3-a456-426614174000 ended.\n`)).toEqual(["shows a run id"]);
  });
  test("a runner id with a timestamp", () => {
    expect(commentProblems(`${ok}Claimed by runner-10289-1793103791470.\n`)).toEqual(["shows a run id"]);
  });
  test("a money amount written with a code or word", () => {
    expect(commentProblems(`${ok}It cost 1.2 USD.\n`)).toEqual(["shows a dollar amount"]);
    expect(commentProblems(`${ok}It cost EUR 3.\n`)).toEqual(["shows a dollar amount"]);
    expect(commentProblems(`${ok}It cost 5 dollars.\n`)).toEqual(["shows a dollar amount"]);
  });
  test("every problem at once", () => {
    expect(commentProblems("**Stage:** build\nclaude-opus-5-5 spent $2 in run-abcd1234\n")).toEqual([
      "opens with something other than one plain sentence",
      "names a model",
      "shows a dollar amount",
      "shows a run id",
    ]);
  });
});

describe("commentProblems allows plain prose with numbers", () => {
  const ok = "<!-- factory:status v1 -->\nThe build finished and verify is next.\n";
  test("counts, dates, versions and ids that are not runs", () => {
    expect(commentProblems(`${ok}I changed 3 files in 12 minutes on 2026-11-01.\n`)).toEqual([]);
    expect(commentProblems(`${ok}Tests 10289 passed, see issue-145-2026.\n`)).toEqual([]);
    expect(commentProblems(`${ok}The user pays in euros and uses 2 USB ports.\n`)).toEqual([]);
  });
});

describe("stripOperatorDetail", () => {
  test("removes each kind and keeps the prose", () => {
    expect(stripOperatorDetail("Built by claude-opus-5-5 for 1.2 USD in runner-10289-1793103791470.")).toBe(
      "Built by [removed] for [removed] in [removed].",
    );
    expect(stripOperatorDetail("I changed 3 files.")).toBe("I changed 3 files.");
  });
});
