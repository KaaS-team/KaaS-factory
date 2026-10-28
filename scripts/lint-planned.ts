// Lints planned-issue bodies before they are filed: `bun scripts/lint-planned.ts body.md...`.
// Exit 1 lists every problem, so an author fixes a body once. tests/import-plan.test.ts runs it.

import { loadConfig, type FactoryConfig } from "../src/config";
import { parsePlannedIssue, planFromIssue } from "../src/engine/import-plan";
import { planMustFix, proofAllowRules } from "../src/engine/plan-critic";

// import-plan refuses an AC command the build may not run, so the lint applies the same rule.
export function lintPlanned(body: string, config: FactoryConfig): string[] {
  const { plan, problems } = parsePlannedIssue(body);
  if (!plan) return problems;
  const { comment } = planFromIssue(plan, { body });
  return [...problems, ...planMustFix(comment, { proof: "test" }, proofAllowRules(config, 0))];
}

if (import.meta.main) {
  const config = await loadConfig(`${import.meta.dir}/..`);
  let bad = 0;
  for (const file of process.argv.slice(2)) {
    const problems = lintPlanned(await Bun.file(file).text(), config);
    for (const p of problems) console.error(`${file}: ${p}`);
    bad += problems.length;
  }
  process.exit(bad ? 1 : 0);
}
