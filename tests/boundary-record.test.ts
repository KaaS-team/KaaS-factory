import { expect, test } from "bun:test";
import { boundaryRecordMissing, isDecisionRecord } from "../src/boundary-record";
import { stageSchema } from "../src/schemas";

test("a plan flagging a boundary change with no decision record is refused", () => {
  expect(boundaryRecordMissing({ boundaryChange: true }, ["src/a.ts"])).toContain("boundary_record_missing");
});

test("a decision record in the diff clears the flag", () => {
  expect(boundaryRecordMissing({ boundaryChange: true }, ["src/a.ts", "docs/decisions/x.md"]) === undefined).toBe(true);
});

test("an unflagged or absent plan is never refused", () => {
  expect(boundaryRecordMissing({}, ["src/a.ts"]) === undefined).toBe(true);
  expect(boundaryRecordMissing(undefined, ["src/a.ts"]) === undefined).toBe(true);
});

test("a non-markdown file under docs/decisions does not count", () => {
  expect(boundaryRecordMissing({ boundaryChange: true }, ["docs/decisions/x.png"])).toContain("docs/decisions/");
});

test("the plan schema knows boundaryChange", () => {
  expect(JSON.stringify(stageSchema("plan"))).toContain("boundaryChange");
});

test("only a named record counts: README, index and nested files do not", () => {
  expect(isDecisionRecord("docs/decisions/0007-title.md")).toBe(true);
  expect(isDecisionRecord("docs/decisions/title.md")).toBe(true);
  expect(isDecisionRecord("docs/decisions/README.md")).toBe(false);
  expect(isDecisionRecord("docs/decisions/index.md")).toBe(false);
  expect(isDecisionRecord("docs/decisions/sub/x.md")).toBe(false);
});
