// Preflight says, before launch, why a run would fail; all I/O is an in-memory fake.
import { describe, expect, test } from "bun:test";
import type { PlannedIssue } from "../src/engine/import-plan";
import { deniesPush, preflight, type PreflightIo } from "../src/supervisor/preflight";

const BRANCH = "factory/issue-324";

const plan = (files: { path: string; isNew: boolean }[], deps: number[] = []): PlannedIssue =>
  ({ files, meta: { deps } }) as unknown as PlannedIssue;

const fakeIo = (
  o: {
    files?: string[];
    done?: number[];
    branches?: string[];
    settings?: string | null;
    reject?: (keyof PreflightIo)[];
  } = {},
): PreflightIo => {
  const fail = (name: keyof PreflightIo) => {
    if (o.reject?.includes(name)) throw new Error("network down");
  };
  return {
    async fileExists(p) {
      fail("fileExists");
      return (o.files ?? ["src/a.ts"]).includes(p);
    },
    async issueDone(n) {
      fail("issueDone");
      return (o.done ?? []).includes(n);
    },
    async branchExists(b) {
      fail("branchExists");
      return (o.branches ?? []).includes(b);
    },
    async readFile() {
      fail("readFile");
      return o.settings ?? null;
    },
  };
};

const edit = plan([
  { path: "src/a.ts", isNew: false },
  { path: "src/b.ts", isNew: true },
]);
const denying = (rule: string) => JSON.stringify({ permissions: { deny: [rule] } });

describe("supervisor preflight", () => {
  test("a clean plan passes", async () => {
    const r = await preflight(plan(edit.files, [7]), BRANCH, fakeIo({ done: [7] }));
    expect(r).toEqual({ ok: true, problems: [] });
  });

  test("a missing file, open dep, taken branch, push deny rule and workflow path each fail alone", async () => {
    const one = async (p: PlannedIssue, io: PreflightIo) => (await preflight(p, BRANCH, io)).problems;
    expect(await one(plan([{ path: "src/gone.ts", isNew: false }]), fakeIo())).toEqual([
      "The plan edits `src/gone.ts`, which the repo does not have: fix the Files list or land that file first.",
    ]);
    expect(await one(plan([], [9]), fakeIo())).toEqual(["Dep #9 is not merged yet: wait for it or drop it from Deps."]);
    expect(await one(edit, fakeIo({ branches: [BRANCH] }))).toEqual([
      `Branch \`${BRANCH}\` already exists: close or delete it before a new run.`,
    ]);
    expect(await one(edit, fakeIo({ settings: denying("Bash(git push*)") }))).toEqual([
      `\`.claude/settings.json\` denies \`Bash(git push*)\`, which blocks \`git push origin ${BRANCH}\`: narrow it to force pushes only.`,
    ]);
    expect(await one(plan([{ path: ".github/workflows/ci.yml", isNew: true }]), fakeIo())).toEqual([
      "The plan writes `.github/workflows/ci.yml`, which the run's token cannot push: stage it under `ci/` and move it by hand.",
    ]);
  });

  test("a rejected io call fails the check it serves", async () => {
    const p = plan([{ path: "src/a.ts", isNew: false }], [7]);
    const r = await preflight(p, BRANCH, fakeIo({ done: [7], reject: ["fileExists"] }));
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain("src/a.ts");
    const dep = await preflight(p, BRANCH, fakeIo({ reject: ["issueDone"] }));
    expect(dep.problems).toEqual(["Dep #7 is not merged yet: wait for it or drop it from Deps."]);
    const br = await preflight(edit, BRANCH, fakeIo({ reject: ["branchExists"] }));
    expect(br.problems.length).toBe(1);
    expect(br.problems[0]).toContain("already exists");
  });

  test("push deny rules: broad ones deny, force-only ones do not", () => {
    for (const rule of ["Bash(git push*)", "Bash(git *)", "Bash(git push:*)", "Bash"]) {
      expect(deniesPush(rule, BRANCH)).toBe(true);
    }
    for (const rule of ["Bash(git push --force*)", "Bash(git push -f*)", "Read(.env)", "WebFetch"]) {
      expect(deniesPush(rule, BRANCH)).toBe(false);
    }
  });

  test("a workflow path fails whether new or edited", async () => {
    for (const isNew of [true, false]) {
      const p = plan([{ path: ".github/workflows/x.yml", isNew }]);
      const r = await preflight(p, BRANCH, fakeIo({ files: [".github/workflows/x.yml"] }));
      expect(r.problems.length).toBe(1);
      expect(r.problems[0]).toContain("cannot push");
    }
  });

  test("invalid settings JSON gives one problem and a missing file gives none", async () => {
    const bad = await preflight(edit, BRANCH, fakeIo({ settings: "{nope" }));
    expect(bad.problems).toEqual(["`.claude/settings.json` is not valid JSON: fix it so its deny rules can be read."]);
    expect((await preflight(edit, BRANCH, fakeIo({ settings: null }))).ok).toBe(true);
  });
});
