// A boundary change needs a decision record in the same diff (src/docs-check.ts).
import { describe, expect, test } from "bun:test";
import { boundaryGlobs, docsMissing } from "../src/docs-check";

const charter =
  "# c\n\n## Boundaries\n\n- `src/api/**`\n- `schema/*.sql`\n- TODO `x/**`\n\n## STOP_IF\n\n- `other/**`\n";

describe("docs check", () => {
  test("a boundary path changed without a decision record is reported", () => {
    const globs = boundaryGlobs(charter);
    expect(globs).toEqual(["src/api/**", "schema/*.sql"]);
    expect(docsMissing(["src/api/users.ts", "src/other.ts", "schema/a.sql"], globs)).toEqual([
      "src/api/users.ts",
      "schema/a.sql",
    ]);
  });
  test("a decision record in the same diff clears it", () => {
    expect(docsMissing(["src/api/users.ts", "docs/decisions/0007-users.md"], boundaryGlobs(charter))).toEqual([]);
  });
  test("no Boundaries section means nothing is checked", () => {
    const globs = boundaryGlobs("# c\n\n## STOP_IF\n\n- `src/api/**`\n");
    expect(globs).toEqual([]);
    expect(docsMissing(["src/api/users.ts"], globs)).toEqual([]);
  });
});
