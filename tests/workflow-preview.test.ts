// A preview runs the stages and makes no write; each write it skips is listed with target and body.

import { afterAll, describe, expect, test } from "bun:test";
import { eventsView } from "../dashboard/workflow-routes";
import { EventBus } from "../src/engine/bus";
import { readJournal } from "../src/engine/journal";
import { defaultWorkflow } from "../src/engine/workflows";
import { evalRuns } from "../src/harness";
import { FactoryState } from "../src/state";
import { processReadyIssue } from "../src/watch";
import { formatPreview } from "../src/workflow-cli";
import { previewDeps, type PreviewWrite } from "../src/workflow-preview";
import { engine, removeEngineDirs } from "./engine-harness";

afterAll(removeEngineDirs);

const CODE_HOST = [
  "createPr",
  "listPrs",
  "getPr",
  "findPrByHead",
  "mergedPrByHead",
  "prFeedback",
  "markReady",
  "closePr",
  "prStatus",
  "mergeReadiness",
  "prDiff",
  "prForIssue",
  "mergePr",
  "prFiles",
  "fileAtRef",
];

async function preview() {
  const wf = defaultWorkflow();
  const e = engine(
    wf,
    0,
    {},
    {},
    {},
    {
      outputs: {
        plan: [
          {
            "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
            "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
          },
        ],
      },
    },
  );
  const calls: string[] = [];
  const trackerWrites: string[] = [];
  const tracked = new Proxy(e.github, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) => {
        if (CODE_HOST.includes(String(p))) calls.push(String(p));
        if (["commentIssue", "addLabels", "removeLabels", "setStateLabel"].includes(String(p)))
          trackerWrites.push(String(p));
        return v.apply(t, a);
      };
    },
  });
  const state = new FactoryState(":memory:");
  const bus = new EventBus({ store: state, sinks: [], source: "factory/acme/widgets", autoDeliver: false });
  const writes: PreviewWrite[] = [];
  const deps = previewDeps({ ...e.deps, github: tracked, bus }, writes);
  const outcome = await processReadyIssue(e.github.issues.get(1)!, deps, e.config);
  return { outcome, writes, calls, trackerWrites, state, e };
}

describe("factory workflow run --preview", () => {
  test("applies no write to the tracker or the code host, and the stages ran", async () => {
    const { outcome, e, trackerWrites } = await preview();
    expect(outcome).toBe("shipped");
    expect(trackerWrites).toEqual([]);
    expect(e.github.createdPrs).toEqual([]);
    expect(e.git.pushed).toEqual([]);
    expect(e.git.claims).toBe(0);
    expect(e.executor.scopes.map(([stage]) => stage)).toContain("verify");
  });

  test("the summary lists each skipped write with its target and body", async () => {
    const { writes } = await preview();
    const ops = writes.map((w) => w.op);
    expect(ops).toContain("createPr");
    expect(ops).toContain("commentIssue");
    expect(ops).toContain("setStateLabel");
    expect(writes.find((w) => w.op === "createPr")!.target).toBe("pull request factory/issue-1");
    expect(writes.find((w) => w.op === "commentIssue")!.body).toContain("factory:");
    const text = formatPreview("shipped", writes).join("\n");
    expect(text).toContain("would createPr -> pull request factory/issue-1");
    expect(text).toContain("Closes #1");
  });

  test("makes zero calls to the code host port", async () => {
    const { calls } = await preview();
    expect(calls).toEqual([]);
  });

  test("its events are marked preview, and neither the journal nor eval counts them", async () => {
    const { state } = await preview();
    const rows = state.busEvents(500);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => JSON.parse(r.data).preview === true)).toBe(true);
    expect(eventsView(state as never, 500, 0).every((v) => v.preview)).toBe(true);
    expect(rows.some((r) => r.type === "factory.run.completed")).toBe(true);
    expect(evalRuns(rows, "acme/widgets", () => 0)).toEqual([]);
  });

  test("a preview's run.completed does not end the real run's journal", () => {
    const wf = defaultWorkflow();
    const row = (type: string, data: object) => ({ type, subject: "issue/1", data: JSON.stringify(data) });
    const base = { workflow: wf.name, sha: wf.sha };
    const rows = [
      row("factory.step.completed", { ...base, step: "triage", result: "next" }),
      row("factory.run.completed", { ...base, step: "pr", outcome: "shipped", preview: true }),
    ];
    expect(readJournal({ busEvents: () => rows as never }, 1, wf).finished.has("triage")).toBe(true);
  });
});

describe("the workflow command", () => {
  test("run without --preview is refused, so a real run is never started by it", async () => {
    const p = Bun.spawn(["bun", "src/cli.ts", "workflow", "run", "feature-to-pr", "--issue", "1"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(p.stderr).text();
    expect(await p.exited).not.toBe(0);
    expect(err).toContain("only --preview is supported");
  });
});
