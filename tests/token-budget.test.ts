// v3.0 token diet: what the runner hands Claude for each stage on the splitbill-demo
// fixture (its AGENTS.md, charter, repo skills and one planned file, copied at 1fa77b6):
// the --append-system-prompt plus the stage skill and the references it always reads.
// v2.12.3 sent AGENTS.md in every pack although CLAUDE.md already imports it, the
// full pack to pr and retro, and nested a verifier subagent inside verify.

import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "../src/agents/presets/claude";
import { runDir } from "../src/artifacts";
import { buildContextPack, STAGE_PACK } from "../src/context";
import type { StageName } from "../src/executor";

const ROOT = join(import.meta.dir, "..");
const ISSUE = 88;

// Bytes per stage, pinned about 10% above what v3.0 measured (v2.12.3 measured the same way
// in brackets, with the verifier subagent's prompt counted in verify). Raise one only with a reason.
const CAP: Record<StageName, number> = {
  triage: 6_600, // 5,971 (10,164)
  plan: 8_100, // 7,330 (10,611)
  build: 11_700, // 10,566 (10,739)
  verify: 7_500, // 6,769 (14,519)
  pr: 3_600, // 3,198 (9,175)
  retro: 3_000, // 2,724 (8,721)
};

// References a stage reads on every run, not only on one route. verify reads prove.md only
// when the runner could not run the proof itself (src/proof.ts).
const ALWAYS_READ: Partial<Record<StageName, string[]>> = {};

const repo = mkdtempSync(join(tmpdir(), "factory-budget-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
cpSync(join(ROOT, "tests", "fixtures", "splitbill"), repo, { recursive: true });
for (const skill of readdirSync(join(ROOT, "template", ".claude", "skills")))
  cpSync(join(ROOT, "template", ".claude", "skills", skill), join(repo, ".claude", "skills", skill), {
    recursive: true,
  });
mkdirSync(join(repo, runDir(ISSUE)), { recursive: true });
writeFileSync(
  join(repo, runDir(ISSUE), "plan.json"),
  JSON.stringify({ risk: "low", revision: 1, files: ["src/money/cents.ts"], autoApproveEligible: true }),
);

async function stageBytes(stage: StageName): Promise<number> {
  const pack = await buildContextPack(stage, ISSUE, repo, { skills: ["handling-money"], contextFile: "CLAUDE.md" });
  const args = claudeArgs({ stage, issue: ISSUE, cwd: repo, maxBudgetUsd: 1 }, pack);
  const system = args[args.indexOf("--append-system-prompt") + 1]!;
  const skillDir = join(repo, ".claude", "skills", `factory-${stage}`);
  const read = ["SKILL.md", ...(ALWAYS_READ[stage] ?? [])].map((f) => readFileSync(join(skillDir, f), "utf8"));
  return Buffer.byteLength(system) + read.reduce((n, s) => n + Buffer.byteLength(s), 0);
}

describe("each stage's prompt stays under its pinned byte cap", () => {
  test("every stage has a cap", () => expect(Object.keys(CAP).sort()).toEqual(Object.keys(STAGE_PACK).sort()));
  for (const stage of Object.keys(CAP) as StageName[])
    test(stage, async () => {
      expect(await stageBytes(stage)).toBeLessThanOrEqual(CAP[stage]);
    });
});

test("AGENTS.md reaches no pack, since the fixture's CLAUDE.md imports it", async () => {
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8")
    .split("\n")
    .find((l) => l.trim().length > 40)!;
  for (const stage of Object.keys(CAP) as StageName[])
    expect(
      await buildContextPack(stage, ISSUE, repo, { skills: ["handling-money"], contextFile: "CLAUDE.md" }),
    ).not.toContain(agents);
});
