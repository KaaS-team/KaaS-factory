import { describe, expect, test } from "bun:test";
import { addedWorkflowLines, pinViolations } from "../scripts/check-action-pins";

const SHA = "a".repeat(40);
const head =
  "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1,2 +1,3 @@\n";
const check = (body: string): string[] => pinViolations(addedWorkflowLines(head + body));

describe("check-action-pins", () => {
  test("an added moving tag is reported with its file and line", () => {
    const out = check("+      - uses: actions/checkout@v4\n");
    expect(out.length).toBe(1);
    expect(out[0]).toContain(".github/workflows/ci.yml");
    expect(out[0]).toContain("actions/checkout@v4");
  });

  test("an added full SHA passes", () => {
    expect(check(`+      - uses: actions/checkout@${SHA} # v4\n`)).toEqual([]);
  });

  test("a short SHA is reported", () => {
    expect(check("+      - uses: actions/checkout@abc1234\n").length).toBe(1);
  });

  test("a 40 character ref that is not hex is reported", () => {
    expect(check(`+      - uses: actions/checkout@${"z".repeat(40)}\n`).length).toBe(1);
  });

  test("a moving tag on a context line is never reported", () => {
    expect(check("       - uses: actions/checkout@v4\n+      - run: echo hi\n")).toEqual([]);
  });

  test("local and docker uses are exempt", () => {
    expect(check("+      - uses: ./.github/actions/setup\n+      - uses: docker://alpine:3\n")).toEqual([]);
  });

  test("pull request text inside a run step is reported", () => {
    const out = check("+        run: echo ${{ github.event.pull_request.title }}\n");
    expect(out.length).toBe(1);
    expect(out[0]).toContain("run step");
  });

  test("body and head ref are reported too", () => {
    expect(check("+        run: echo ${{ github.event.pull_request.body }}\n").length).toBe(1);
    expect(check("+        run: git checkout ${{ github.event.pull_request.head.ref }}\n").length).toBe(1);
  });

  test("an empty diff has no lines and no violations", () => {
    expect(addedWorkflowLines("")).toEqual([]);
    expect(pinViolations([])).toEqual([]);
  });

  test("added lines outside the workflows directory are ignored", () => {
    const diff = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+uses: actions/checkout@v4\n";
    expect(addedWorkflowLines(diff)).toEqual([]);
  });
});
