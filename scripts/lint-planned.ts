// Lints planned-issue bodies before they are filed: `bun scripts/lint-planned.ts body.md...`.
// Exit 1 lists every problem, so an author fixes a body once. tests/import-plan.test.ts runs it.

import { join } from "node:path";
import { loadConfig } from "../src/config";
import { parsePlannedIssue, planFromIssue } from "../src/engine/import-plan";
import { planMustFix, proofAllowRules } from "../src/engine/plan-critic";

// The AC command rule reads the rendered plan comment, as import-plan does, so a body that lints clean is not refused on import.
export function lintPlanned(body: string, allow: readonly string[]): string[] {
  const { plan, problems } = parsePlannedIssue(body);
  if (!plan) return problems;
  return [...problems, ...planMustFix(planFromIssue(plan, { body }).comment, { proof: "test" }, allow)];
}

if (import.meta.main) {
  const allow = proofAllowRules(await loadConfig(join(import.meta.dir, "..")), 0);
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const problems = lintPlanned(await Bun.file(file).text(), allow);
    for (const p of problems) console.error(`${file}: ${p}`);
    bad += problems.length;
  }
  process.exit(bad ? 1 : 0);
}
