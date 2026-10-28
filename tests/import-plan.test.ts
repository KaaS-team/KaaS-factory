import { expect, test } from "bun:test";
import { lintPlanned } from "../scripts/lint-planned";
import { loadConfig } from "../src/config";
import { isPlannedBody, parsePlannedIssue, planFromIssue } from "../src/engine/import-plan";
import { proofAllowRules } from "../src/engine/plan-critic";
import { schemaProblem } from "../src/schemas";

const read = (n: string) => Bun.file(`${import.meta.dir}/fixtures/${n}`).text();
const noMarker = async () => (await read("planned-issue.md")).replace("<!-- factory:planned v1 -->\n", "");
const unmapped = async () => (await read("planned-issue.md")).replace("(T2)", "(T9)");
const fileMissing = async () => (await read("planned-issue.md")).replace("- `src/derive.ts`\n", "");

test("a planned issue round-trips into a plan and a plan comment", async () => {
  const body = await read("planned-issue.md");
  const { plan, problems } = parsePlannedIssue(body);
  expect(problems).toEqual([]);
  const out = planFromIssue(plan!, { body });
  expect(out.plan.tasks).toHaveLength(2);
  expect(out.plan.criteria.map((c) => c.id)).toEqual(["AC-1", "AC-2"]);
  expect(out.plan.source).toBe("issue");
  expect(out.comment).toContain("- **AC-1:** a build failure resumes at build: checked by `tests/resume.test.ts`");
  expect(out.comment).toContain("`tests/resume.test.ts` (new)");
  expect(schemaProblem("plan", out.plan as unknown as Record<string, unknown>)).toBeUndefined();
});

test("lint-planned exits 0 on the fixture and 1 on a broken body", async () => {
  const run = (f: string) =>
    Bun.spawnSync(["bun", "scripts/lint-planned.ts", f], { cwd: `${import.meta.dir}/..`, stderr: "pipe" });
  expect(run("tests/fixtures/planned-issue.md").exitCode).toBe(0);
  const broken = `${import.meta.dir}/fixtures/planned-broken.tmp.md`;
  await Bun.write(broken, await unmapped());
  const r = run(broken);
  await Bun.file(broken).delete();
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("AC-2 maps to T9");
});

test("lintPlanned refuses an AC command build may not run, and accepts one it may", async () => {
  const allow = proofAllowRules(await loadConfig(`${import.meta.dir}/..`), 0);
  const body = await read("planned-issue.md");
  const bad = body.replace("checked by `tests/resume.test.ts` (T1)", "checked by `bun test x` (T1)");
  expect(lintPlanned(bad, allow).join("\n")).toContain("AC-1: `bun test x` is not a command build or verify may run");
  const good = body.replace("checked by `tests/resume.test.ts` (T1)", 'checked by `make test FILES="x"` (T1)');
  expect(lintPlanned(good, allow)).toEqual([]);
});

test("a body without the marker is not planned", async () => {
  const body = await noMarker();
  expect(isPlannedBody(body)).toBe(false);
  expect(parsePlannedIssue(body).problems[0]).toContain("factory:planned v1");
});

test("an AC that maps to no task is a problem", async () => {
  const { plan, problems } = parsePlannedIssue(await unmapped());
  expect(plan).toBeUndefined();
  expect(problems.join("\n")).toContain("AC-2 maps to T9");
});

test("a task file missing from ## Files is a problem", async () => {
  const { problems } = parsePlannedIssue(await fileMissing());
  expect(problems.join("\n")).toContain('`src/derive.ts`, which "## Files" does not list');
});

test("every problem is collected, not only the first", async () => {
  const body = (await unmapped()).replace("- `src/derive.ts`\n", "");
  expect(parsePlannedIssue(body).problems.length).toBeGreaterThanOrEqual(2);
});
