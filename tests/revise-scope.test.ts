import { describe, expect, test } from "bun:test";
import type { GhComment } from "../src/github";
import { reviseScope, scopePrompt } from "../src/revise-scope";

const comment = (json: unknown, id = 1): GhComment =>
  ({ id, body: `x\n\n<!-- factory:data ${JSON.stringify({ stage: "verify", json })} -->` }) as GhComment;

describe("reviseScope", () => {
  test("reads the sha and findings from the latest verify marker", () => {
    const scope = reviseScope([
      comment({ reviewedSha: "aaaaaaa", findings: ["old"] }, 1),
      comment({ reviewedSha: "abc1234", findings: ["bad name", { what: "leak" }, 4] }, 2),
    ]);
    expect(scope).toEqual({ sha: "abc1234", findings: ["bad name", "leak"] });
  });

  test("no usable sha means no scope", () => {
    expect(reviseScope([comment({ findings: [] })])).toBe(undefined as never);
    expect(reviseScope([comment({ reviewedSha: "--all" })])).toBe(undefined as never);
    expect(scopePrompt(undefined)).toBe("");
  });

  test("the prompt names the range and each finding", () => {
    const text = scopePrompt({ sha: "abc1234", findings: ["leak"] });
    expect(text).toContain("git diff abc1234..HEAD");
    expect(text).toContain("Earlier confirmed finding: leak");
  });
});
