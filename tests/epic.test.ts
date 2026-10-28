import { describe, expect, test } from "bun:test";
import {
  checklist,
  childIssues,
  closingLine,
  commitByTask,
  conventionalTitle,
  conventionalType,
  epicProgress,
  renderTaskTable,
  scopeOf,
  settleEpic,
  taskCommitMessage,
  tickAll,
} from "../src/engine/epic";
import { buildInbox } from "../src/inbox";
import { FakeGitHub } from "./harness";

const BODY = "Epic\n\n- [x] #11 first\n- [ ] #12 second\n* [ ] #13 third, see #11\n- [ ] no ref\nplain #99 text";
const tasks = [
  { id: "T1", title: "Add the epic module", files: ["src/engine/epic.ts"] },
  { id: "T2", title: "Commit per task", files: ["src/git.ts", "src/engine/steps.ts"] },
];

describe("epic checklist", () => {
  test("reads items and refs only from checklist lines", () => {
    expect(checklist(BODY).map((i) => [i.done, i.issues])).toEqual([
      [true, [11]],
      [false, [12]],
      [false, [13, 11]],
      [false, []],
    ]);
    expect(childIssues(BODY, 12)).toEqual([11, 13]);
  });
  test("progress counts ticked items; none without a checklist", () => {
    expect(epicProgress(BODY)).toEqual({ done: 1, total: 4 });
    expect(epicProgress("no list")).toBeUndefined();
  });
  test("closing line names the issue then each child", () => {
    expect(closingLine(5, [6, 7])).toBe("Closes #5, closes #6, closes #7");
    expect(closingLine(5, [])).toBe("Closes #5");
  });
  test("tickAll ticks every open item and leaves done ones", () => {
    expect(tickAll(BODY)).toBe(BODY.replace(/\[ \]/g, "[x]"));
  });
});

describe("conventional titles and commits", () => {
  test("type follows the triage type", () => {
    expect([conventionalType("bug"), conventionalType("security"), conventionalType("docs")]).toEqual([
      "fix",
      "fix",
      "docs",
    ]);
    expect([conventionalType("dependency"), conventionalType("feature"), conventionalType(undefined)]).toEqual([
      "chore",
      "feat",
      "feat",
    ]);
  });
  test("scope is the shared directory", () => {
    expect(scopeOf(["src/engine/a.ts", "src/engine/b.ts"])).toBe("engine");
    expect(scopeOf(["src/a.ts", "tests/a.test.ts"])).toBeUndefined();
    expect(scopeOf([])).toBeUndefined();
  });
  test("title stays within 72 characters and keeps the ref and acronyms", () => {
    const t = conventionalTitle("feat", "engine", "Group PRs by epic ".repeat(8), "#225");
    expect(t.length).toBeLessThanOrEqual(72);
    expect(t.endsWith(" (#225)")).toBe(true);
    expect(conventionalTitle("fix", undefined, "PRs stay", "#1")).toBe("fix: PRs stay (#1)");
    expect(conventionalTitle("feat", "x", "Add a thing", "#1")).toBe("feat(x): add a thing (#1)");
  });
  test("a task commit names the task and carries no operator detail", () => {
    const msg = taskCommitMessage({ ...tasks[0]!, model: "haiku" } as never, "Ship epics", "feat", "#225");
    expect(msg).toBe("feat(engine): add the epic module\n\nShip epics\n\nTask T1 of #225.");
    expect(msg).not.toMatch(/haiku|sonnet|opus|\$|claude\.ai/i);
  });
});

describe("task table", () => {
  test("one row per task with its criteria and their status", () => {
    const table = renderTaskTable(
      tasks,
      [
        { id: "AC-1", task: "T1" },
        { id: "AC-2", task: "T2" },
      ],
      [{ id: "AC-1", status: "pass" }],
    );
    expect(table).toContain("| T1: Add the epic module | `src/engine/epic.ts` | AC-1 pass |");
    expect(table).toContain("| T2: Commit per task | `src/git.ts`, `src/engine/steps.ts` | AC-2 not run |");
  });
  test("a single task needs no table", () => {
    expect(renderTaskTable([tasks[0]!], [], undefined)).toBe("");
  });
});

describe("commitByTask", () => {
  const input = { goal: "Ship epics", type: "feat", ref: "#225", title: "Epic PRs", files: ["src/a.ts"] };
  test("one commit per task in plan order, then a closing commit", async () => {
    const calls: string[] = [];
    const git = {
      commitAll: async (_: string, m: string) => {
        calls.push(`all:${m.split("\n")[0]}`);
        return true;
      },
      commitPaths: async (_: string, p: readonly string[], m: string) => (
        calls.push(`${p.join("+")}:${m.split("\n")[0]}`), true
      ),
    };
    await commitByTask(git, "/w", { ...input, tasks });
    expect(calls).toEqual([
      "src/engine/epic.ts:feat(engine): add the epic module",
      "src/git.ts+src/engine/steps.ts:feat(src): commit per task",
      "all:feat(src): epic PRs (#225)",
    ]);
  });
  test("fewer than two tasks is one commit", async () => {
    const calls: string[] = [];
    const git = {
      commitAll: async (_: string, m: string) => (calls.push(m), true),
      commitPaths: async () => false,
    };
    await commitByTask(git, "/w", { ...input, tasks: [tasks[0]!] });
    expect(calls).toHaveLength(1);
  });
});

describe("settleEpic", () => {
  test("closes the children and ticks the body", async () => {
    const gh = new FakeGitHub([]);
    await settleEpic(gh, "o/r", { number: 5, body: "- [ ] #6 a\n- [ ] #7 b" });
    expect(gh.closed).toEqual([6, 7]);
    expect(gh.edited).toEqual([{ number: 5, body: "- [x] #6 a\n- [x] #7 b" }]);
  });
  test("a failed close is logged and the rest still happens", async () => {
    const gh = new FakeGitHub([]);
    gh.closeIssue = async (_r, n) => {
      if (n === 6) throw new Error("boom");
      gh.closed.push(n);
    };
    await settleEpic(gh, "o/r", { number: 5, body: "- [ ] #6 a\n- [ ] #7 b" });
    expect(gh.closed).toEqual([7]);
    expect(gh.edited).toHaveLength(1);
  });
  test("a body with no checklist does nothing", async () => {
    const gh = new FakeGitHub([]);
    await settleEpic(gh, "o/r", { number: 5, body: "plain" });
    expect(gh.closed).toEqual([]);
    expect(gh.edited).toEqual([]);
  });
});

describe("inbox progress", () => {
  test("an epic waiting on a human shows its progress", () => {
    const issue = {
      number: 5,
      title: "Epic",
      body: BODY,
      labels: [{ name: "factory:awaiting-approval" }],
      comments: [],
    };
    expect(buildInbox([issue as never])[0]?.progress).toEqual({ done: 1, total: 4 });
    expect("progress" in buildInbox([{ ...issue, body: "x" } as never])[0]!).toBe(false);
  });
});
