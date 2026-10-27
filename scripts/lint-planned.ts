// Lints planned-issue bodies before they are filed: `bun scripts/lint-planned.ts body.md...`.
// Exit 1 lists every problem, so an author fixes a body once. tests/import-plan.test.ts runs it.

import { parsePlannedIssue } from "../src/engine/import-plan";

export function lintPlanned(body: string): string[] {
  return parsePlannedIssue(body).problems;
}

if (import.meta.main) {
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const problems = lintPlanned(await Bun.file(file).text());
    for (const p of problems) console.error(`${file}: ${p}`);
    bad += problems.length;
  }
  process.exit(bad ? 1 : 0);
}
