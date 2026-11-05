// #637: a workflow declares its outputs (issue, comment, pull_request, label) with a per-run
// maximum, a title prefix and an expiry; the executor refuses the rest and records the refusal.

import { afterAll, describe, expect, test } from "bun:test";
import { fireCron } from "../src/engine/triggers";
import { defaultWorkflow, parseWorkflowText } from "../src/engine/workflows";
import { closeExpired, expiryLine, gateScm, WriteRefused } from "../src/safe-outputs";
import { baseIssue, FakeGitHub } from "./harness";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const STEPS = "steps:\n  a:\n    uses: report\n    label: factory:reporting\n";
const parse = (head: string) => {
  const r = parseWorkflowText(`name: w\n${head}${STEPS}`);
  return r.ok ? r.workflow : r.problems;
};
const FACTORY = "<!-- factory:notice -->";

describe("declaring outputs", () => {
  test("a workflow declares each output with a maximum, a title prefix and an expiry", () => {
    const w = parse(
      'outputs:\n  issue: { max: 3, title_prefix: "[bot] ", expires: 7 }\n  comment: { max: 2 }\n  label: { max: 1 }\n  pull_request: { max: 1, title_prefix: "[bot] ", on_protected_path: issue }\n',
    );
    expect(w).toMatchObject({
      outputs: {
        issue: { max: 3, titlePrefix: "[bot] ", expiresDays: 7 },
        comment: { max: 2 },
        label: { max: 1 },
        pull_request: { max: 1, titlePrefix: "[bot] ", onProtectedPath: "issue" },
      },
    });
  });

  test("a workflow with no outputs declares none", () => {
    expect((parse("") as { outputs?: unknown }).outputs).toBe(undefined);
  });

  test.each([
    ["no max", "outputs:\n  issue: {}\n", "outputs.issue.max: required"],
    ["a max of zero", "outputs:\n  issue: { max: 0 }\n", "outputs.issue.max: required"],
    ["an unknown output", "outputs:\n  release: { max: 1 }\n", "outputs.release: unknown output"],
    ["a prefix on a comment", 'outputs:\n  comment: { max: 1, title_prefix: "x" }\n', "outputs.comment.title_prefix"],
    [
      "an expiry on a pull request",
      "outputs:\n  pull_request: { max: 1, expires: 3 }\n",
      "outputs.pull_request.expires",
    ],
    [
      "a protected-path fallback with no issue output",
      "outputs:\n  pull_request: { max: 1, on_protected_path: issue }\n",
      "declare outputs.issue",
    ],
    ["an unknown key", "outputs:\n  issue: { max: 1, color: red }\n", "outputs.issue.color: unknown key"],
  ])("%s is refused at load", (_n, head, problem) => {
    expect(parse(head)).toEqual([expect.stringContaining(problem)]);
  });
});

describe("the executor's gate", () => {
  const outputs = (o: Record<string, unknown>) => {
    const w = parse(
      `outputs:\n${Object.entries(o)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")}\n`,
    );
    if (Array.isArray(w)) throw new Error(w.join());
    return w.outputs!;
  };
  const gated = (o: Record<string, unknown>, at = new Date("2026-11-01T00:00:00Z")) => {
    const gh = new FakeGitHub([baseIssue(1, []), baseIssue(2, [])]);
    return { gh, scm: gateScm(gh, outputs(o), new Map(), 1, () => at) };
  };

  test("a write the workflow did not declare is refused", async () => {
    const { gh, scm } = gated({ comment: "{ max: 1 }" });
    await expect(scm.createIssue("o/r", "t", "b", [])).rejects.toThrow("declares no issue output");
    expect(gh.issues.size).toBe(2);
  });

  test("writes up to the maximum pass and the next one is refused", async () => {
    const { gh, scm } = gated({ issue: "{ max: 2 }" });
    await scm.createIssue("o/r", "one", "b", []);
    await scm.createIssue("o/r", "two", "b", []);
    await expect(scm.createIssue("o/r", "three", "b", [])).rejects.toThrow(WriteRefused);
    expect([...gh.issues.values()].map((i) => i.title)).toEqual([
      baseIssue(1, []).title,
      baseIssue(2, []).title,
      "one",
      "two",
    ]);
  });

  test("the title prefix is put in front once, and an expiry line is added to an issue", async () => {
    const { gh, scm } = gated({ issue: '{ max: 3, title_prefix: "[bot] ", expires: 7 }' });
    await scm.createIssue("o/r", "found", "body", []);
    await scm.createIssue("o/r", "[bot] again", "body", []);
    const [a, b] = [...gh.issues.values()].slice(2);
    expect(a!.title).toBe("[bot] found");
    expect(b!.title).toBe("[bot] again");
    expect(a!.body).toContain("<!-- factory:expires 2026-11-08T00:00:00.000Z -->");
  });

  test("a pull request is prefixed and counted", async () => {
    const { gh, scm } = gated({ pull_request: '{ max: 1, title_prefix: "[bot] " }' });
    const opts = { repo: "o/r", base: "main", head: "h", title: "fix", body: "b" };
    await scm.createPr(opts);
    expect(gh.createdPrs[0]!.title).toBe("[bot] fix");
    await expect(scm.createPr(opts)).rejects.toThrow("past the maximum of 1");
  });

  test("a label of the workflow's own is counted; the factory's state labels are not", async () => {
    const { scm } = gated({ label: "{ max: 1 }" });
    await scm.addLabels("o/r", 2, ["factory:ready", "factory:planning", "triaged"]);
    await expect(scm.addLabels("o/r", 2, ["other"])).rejects.toThrow("label: past the maximum");
  });

  test("a comment on another item is counted; one on the run's own thread is not", async () => {
    const { scm } = gated({ comment: "{ max: 1 }" });
    for (let i = 0; i < 3; i++) await scm.commentIssue("o/r", 1, "status");
    await scm.commentIssue("o/r", 2, "one");
    await expect(scm.commentIssue("o/r", 2, "two")).rejects.toThrow("comment: past the maximum");
    const { scm: none } = gated({ issue: "{ max: 1 }" });
    await expect(none.commentIssue("o/r", 2, "x")).rejects.toThrow("declares no comment output");
  });
});

const protectedConfig = { config: { protectedPaths: ["src/secret/**"] } };
const run = (outputs: object, changed: string[], config: object = {}) => {
  const e = engine(
    { ...defaultWorkflow(), outputs } as never,
    0,
    {},
    {},
    {},
    {
      outputs: {
        plan: [
          {
            "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\np",
            "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
          },
        ],
      },
      ...config,
    },
  );
  e.git.changed = changed;
  e.git.diffText = "diff --git a/src/secret/a.ts b/src/secret/a.ts\n+leak";
  return e;
};

describe("through the engine", () => {
  test("a declared pull request ships with its prefix", async () => {
    const e = run({ pull_request: { max: 1, titlePrefix: "[bot] " } }, ["src/a.ts"]);
    expect(await e.run()).toBe("shipped");
    expect(e.github.createdPrs[0]!.title).toStartWith("[bot] ");
  });

  test("a pull request the workflow did not declare fails the run, and the refusal is on the run", async () => {
    const e = run({ issue: { max: 1 } }, ["src/a.ts"]);
    expect(await e.run()).toBe("failed");
    expect(e.github.createdPrs).toHaveLength(0);
    expect(e.deps.state.getRun("acme/widgets", 1)!.reason).toContain(
      "write refused: the workflow declares no pull_request output",
    );
    const events = e.deps.state.listEvents(e.deps.state.getRun("acme/widgets", 1)!.id);
    expect(events.find((ev) => ev.kind === "write_refused")?.text).toContain("declares no pull_request output");
  });

  test("a pull request that touches a protected path becomes an issue with the diff, when the workflow says so", async () => {
    const e = run(
      { pull_request: { max: 1, onProtectedPath: "issue" }, issue: { max: 1, titlePrefix: "[held] ", expiresDays: 7 } },
      ["src/secret/a.ts"],
      protectedConfig,
    );
    expect(await e.run()).toBe("needs-human");
    expect(e.github.createdPrs).toHaveLength(0);
    const filed = e.github.issues.get(2)!;
    expect(filed.title).toStartWith("[held] Protected paths");
    expect(filed.body).toContain("+leak");
    expect(filed.body).toContain("`src/secret/a.ts`");
    expect(filed.body).toContain("<!-- factory:expires ");
  });

  test("without the fallback a protected-path change parks the run and files nothing", async () => {
    const e = run({ pull_request: { max: 1 } }, ["src/secret/a.ts"], protectedConfig);
    expect(await e.run()).toBe("needs-human");
    expect(e.github.issues.size).toBe(1);
    expect(e.deps.state.getRun("acme/widgets", 1)!.reason).toContain("touched protected path(s)");
  });
});

describe("expiry", () => {
  const issue = (n: number, due: string, comments: string[] = []) => ({
    ...baseIssue(n, []),
    body: `body\n\n<!-- factory:expires ${due} -->`,
    comments: comments.map((body, i) => ({
      id: i,
      author: "a",
      authorAssociation: "NONE",
      body,
      createdAt: "2026-11-01T00:00:00Z",
    })),
  });
  const NOW = new Date("2026-11-10T00:00:00Z");

  test("an item past its expiry with no human activity is closed with one comment saying why", async () => {
    const gh = new FakeGitHub([issue(5, "2026-11-08T00:00:00.000Z", [`status ${FACTORY}`])]);
    expect(await closeExpired(gh, "o/r", NOW)).toEqual([5]);
    expect(gh.closed).toEqual([5]);
    const added = gh.issues.get(5)!.comments.filter((c) => c.body.includes("expired"));
    expect(added).toHaveLength(1);
    expect(added[0]!.body).toContain("expired on 2026-11-08");
  });

  test("an item with a human comment, or not yet due, is left open", async () => {
    const gh = new FakeGitHub([
      issue(5, "2026-11-08T00:00:00.000Z", ["still wanted"]),
      issue(6, "2026-11-20T00:00:00.000Z"),
    ]);
    expect(await closeExpired(gh, "o/r", NOW)).toEqual([]);
    expect(gh.closed).toEqual([]);
  });

  test("the expiry line carries the declared number of days", () => {
    expect(expiryLine(30, new Date("2026-11-01T00:00:00Z"))).toBe("<!-- factory:expires 2026-12-01T00:00:00.000Z -->");
  });

  test("the watcher's cron poll sweeps a workflow that sets an expiry, once an hour", async () => {
    const w = parseWorkflowText(`name: w\noutputs:\n  issue: { max: 1, expires: 7 }\n${STEPS}`);
    if (!w.ok) throw new Error(w.problems.join());
    const gh = new FakeGitHub([issue(5, "2026-11-08T00:00:00.000Z")]);
    const kv = new Map<string, string>();
    const store = { getSetting: (k: string) => kv.get(k), setSetting: (k: string, v: string) => void kv.set(k, v) };
    await fireCron(gh, store, "o/r", w.workflow, NOW);
    expect(gh.closed).toEqual([5]);
    gh.issues.get(5)!.state = "CLOSED";
    gh.issues.set(6, issue(6, "2026-11-08T00:00:00.000Z"));
    await fireCron(gh, store, "o/r", w.workflow, new Date(NOW.getTime() + 60_000));
    expect(gh.closed).toEqual([5]);
    await fireCron(gh, store, "o/r", w.workflow, new Date(NOW.getTime() + 61 * 60_000));
    expect(gh.closed).toEqual([5, 6]);
  });
});

describe("a stop date", () => {
  const sched = (until: string) => {
    const w = parseWorkflowText(
      `name: nightly\non:\n${until}  cron:\n    - schedule: "0 2 * * *"\n      title: Nightly\n${STEPS}`,
    );
    if (!w.ok) throw new Error(w.problems.join());
    return w.workflow;
  };
  const store = () => {
    const kv = new Map<string, string>();
    return { getSetting: (k: string) => kv.get(k), setSetting: (k: string, v: string) => void kv.set(k, v) };
  };

  test("a scheduled workflow files its issue through the stop date", async () => {
    const gh = new FakeGitHub([]);
    const filed = await fireCron(gh, store(), "o/r", sched("  until: 2026-10-09\n"), new Date("2026-10-09T02:00:00Z"));
    expect(filed).toHaveLength(1);
  });

  test("after the stop date it no longer runs", async () => {
    const gh = new FakeGitHub([]);
    const filed = await fireCron(gh, store(), "o/r", sched("  until: 2026-10-09\n"), new Date("2026-10-10T02:00:00Z"));
    expect(filed).toEqual([]);
    expect(gh.issues.size).toBe(0);
  });

  test("without a stop date it keeps running", async () => {
    const filed = await fireCron(new FakeGitHub([]), store(), "o/r", sched(""), new Date("2030-10-10T02:00:00Z"));
    expect(filed).toHaveLength(1);
  });

  test("a stop date that is not a date is refused at load", () => {
    const r = parseWorkflowText(`name: w\non:\n  until: soon\n${STEPS}`);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join()).toContain("on.until");
    expect(parseWorkflowText(`name: w\non:\n  until: 2026-02-31\n${STEPS}`).ok).toBe(false);
  });
});
