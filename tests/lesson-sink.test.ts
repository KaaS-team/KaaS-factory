import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lessonSinkFromEnv, makeLessonSink, SINK_ENV, tenantOf, type BrainCaller } from "../src/lesson-sink";
import { runLearn } from "../src/learn";
import { FactoryState } from "../src/state";
import { FakeGit, FakeGitHub } from "./harness";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

class FakeBrain implements BrainCaller {
  calls: { name: string; args: Record<string, unknown> }[] = [];
  constructor(private readonly fail = false) {}
  async callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (this.fail) throw new Error("down");
    return {};
  }
}

function setup() {
  mkdirSync(tmpdir(), { recursive: true });
  const workspacesDir = mkdtempSync(join(tmpdir(), "factory-sink-ws-"));
  const cloneDir = mkdtempSync(join(tmpdir(), "factory-sink-clone-"));
  dirs.push(workspacesDir, cloneDir);
  const state = new FactoryState(":memory:");
  const git = new FakeGit();
  git.changed = [".factory/memory/lessons.md"];
  const base = { github: new FakeGitHub([]), git, state, cloneDir, workspacesDir };
  return { base, state };
}

describe("lesson sink", () => {
  test("tenant is the repo owner", () => {
    expect(tenantOf("acme/widgets")).toBe("acme");
  });

  test("posts one page per lesson and skips rows with only a skill edit", async () => {
    const brain = new FakeBrain();
    const state = new FactoryState(":memory:");
    const a = state.queueRetro("acme/widgets", 7, "merged");
    state.completeRetro(a, { lesson: "Add the regression test first." });
    const b = state.queueRetro("acme/widgets", 8, "merged");
    state.completeRetro(b, { skill_name: "factory-build", skill_edit: "tighten" });
    const n = await makeLessonSink(brain, "add_page").push("acme/widgets", state.listRetros("acme/widgets"));
    expect(n).toBe(1);
    expect(brain.calls).toHaveLength(1);
    expect(brain.calls[0]!.name).toBe("add_page");
    expect(brain.calls[0]!.args.tenant).toBe("acme");
    expect(brain.calls[0]!.args.content).toBe("Add the regression test first.");
  });

  test("an unreachable brain posts nothing and does not throw", async () => {
    const state = new FactoryState(":memory:");
    const a = state.queueRetro("acme/widgets", 7, "merged");
    state.completeRetro(a, { lesson: "x" });
    const n = await makeLessonSink(new FakeBrain(true), "t").push("acme/widgets", state.listRetros("acme/widgets"));
    expect(n).toBe(0);
  });

  test("without a url and tool there is no sink", () => {
    expect(lessonSinkFromEnv({})).toBe(undefined);
    expect(lessonSinkFromEnv({ [SINK_ENV.url]: "http://x" })).toBe(undefined);
    expect(lessonSinkFromEnv({ [SINK_ENV.url]: "http://x", [SINK_ENV.tool]: "t" })).not.toBe(undefined);
  });

  test("runLearn with the sink creates a page; without it nothing is posted", async () => {
    const brain = new FakeBrain();
    const withSink = setup();
    const id = withSink.state.queueRetro("acme/widgets", 7, "merged");
    withSink.state.completeRetro(id, { lesson: "Lesson one." });
    const r = await runLearn({ ...withSink.base, sink: makeLessonSink(brain, "add_page") }, "acme/widgets", "main");
    expect(r.batched).toBe(1);
    expect(brain.calls).toHaveLength(1);

    const without = setup();
    const id2 = without.state.queueRetro("acme/widgets", 7, "merged");
    without.state.completeRetro(id2, { lesson: "Lesson one." });
    const r2 = await runLearn(without.base, "acme/widgets", "main");
    expect(r2.batched).toBe(1);
    expect(brain.calls).toHaveLength(1);
  });
});
