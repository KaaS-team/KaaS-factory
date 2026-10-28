import { expect, test } from "bun:test";
import { isPlannedBody, parsePlannedIssue, planFromIssue } from "../src/engine/import-plan";
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

test("task deps: an unknown dep and a cycle are problems, and tasks come out dependency first", async () => {
  const body = await read("planned-issue.md");
  const unknown = parsePlannedIssue(body.replace("Deps: T1", "Deps: T9"));
  expect(unknown.problems.join("\n")).toContain("T2 depends on T9");
  const cyclic = parsePlannedIssue(body.replace("Model: haiku\n", "Model: haiku\nDeps: T2\n"));
  expect(cyclic.problems.join("\n")).toContain("form a cycle");
  const swapped = body.replace("Deps: T1", "Deps: none").replace("Model: haiku\n", "Model: haiku\nDeps: T2\n");
  const { plan } = parsePlannedIssue(swapped);
  expect(planFromIssue(plan!, { body: swapped }).plan.tasks.map((t) => t.id)).toEqual(["T2", "T1"]);
});

test("a bad preface line is a problem", async () => {
  const body = (await read("planned-issue.md")).replace("Milestone: M1", "Runner: robot");
  expect(parsePlannedIssue(body).problems.join("\n")).toContain('Runner: "robot"');
});
