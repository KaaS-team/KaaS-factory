// The tmux view: the argv it sends, one real tmux on a private socket, and the
// rule that a broken view never fails a stage. Real tmux is required here (CI
// installs it), so a missing binary fails the suite instead of skipping.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { FactoryState } from "../src/state";
import {
  issueWindow,
  shellQuote,
  ShellTmuxRunner,
  Tmux,
  tmuxIssueView,
  type IssueView,
  type TmuxRunner,
} from "../src/tmux";
import { processReadyIssue } from "../src/watch";
import { LABEL } from "../src/labels";
import {
  baseIssue,
  FakeGateRunner,
  FakeGit,
  FakeGitHub,
  FakeHoldoutRunner,
  fixtureFor,
  MultiStageExecutor,
} from "./harness";

class FakeRunner implements TmuxRunner {
  readonly calls: string[][] = [];
  constructor(
    private readonly windows: string[] = [],
    private readonly session = true,
  ) {}
  async run(args: readonly string[]) {
    this.calls.push([...args]);
    if (args[0] === "has-session") return { code: this.session ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "list-windows") return { code: 0, stdout: this.windows.join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("tmux argv", () => {
  test("a missing window is created detached, following the quoted stream file in colour", async () => {
    const runner = new FakeRunner(["watch"]);
    await tmuxIssueView(new Tmux(runner, "factory"), "acme/widgets", "factory").show(7, "/h/it's.log");
    expect(runner.calls.at(-1)).toEqual([
      "new-window",
      "-d",
      "-t",
      "=factory:",
      "-n",
      "widgets-7",
      `factory view ${shellQuote("/h/it's.stream.jsonl")} --follow`,
    ]);
  });

  test("an existing window is left alone, and a missing session is created first", async () => {
    const existing = new FakeRunner(["widgets-7"]);
    await tmuxIssueView(new Tmux(existing, "factory"), "acme/widgets", "factory").show(7, "/x.log");
    expect(existing.calls.some((c) => c[0] === "new-window")).toBe(false);
    const none = new FakeRunner([], false);
    await new Tmux(none, "s").ensureSession();
    expect(none.calls.at(-1)).toEqual(["new-session", "-d", "-s", "s", "-x", "200", "-y", "50"]);
  });

  test("window names carry the repo so two repos can share a session", () => {
    expect(issueWindow("acme/splitbill-demo", 12)).toBe("splitbill-demo-12");
  });
});

describe("real tmux on a private socket", () => {
  const socket = `factory-test-${process.pid}`;
  const runner = new ShellTmuxRunner(socket);
  afterAll(() => runner.run(["kill-server"]));

  test("an issue window opens, streams the file, and closes", async () => {
    const tmux = new Tmux(runner, "t");
    expect(await tmux.version()).toMatch(/^tmux /);
    const dir = mkdtempSync(join(tmpdir(), "factory-tmux-"));
    const file = join(dir, "issue-3.log");
    await Bun.write(join(dir, "issue-3.stream.jsonl"), "hello from the agent\n");
    const view = tmuxIssueView(
      tmux,
      "acme/widgets",
      [process.execPath, join(import.meta.dir, "..", "bin", "factory")].map(shellQuote).join(" "),
    );
    await view.show(3, file);
    await view.show(3, file);
    expect((await tmux.windows()).filter((w) => w === "widgets-3")).toHaveLength(1);
    let pane = "";
    for (let i = 0; i < 100 && !pane.includes("hello from the agent"); i++) {
      await Bun.sleep(50);
      pane = (await runner.run(["capture-pane", "-p", "-t", "=t:=widgets-3"])).stdout;
    }
    expect(pane).toContain("hello from the agent");
    await view.close(3);
    expect(await tmux.windows()).not.toContain("widgets-3");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the view never fails a stage", () => {
  test("a throwing view still ships, and a shipped run closes its window", async () => {
    const shown: number[] = [];
    const closed: number[] = [];
    const view: IssueView = {
      show: async (n) => {
        shown.push(n);
        throw new Error("no server running");
      },
      close: async (n) => {
        closed.push(n);
      },
    };
    const home = mkdtempSync(join(tmpdir(), "factory-view-"));
    const github = new FakeGitHub([baseIssue(1, [LABEL.ready])]);
    const state = new FactoryState(":memory:");
    state.setToggle("auto_approve_low_risk", true);
    const executor = new MultiStageExecutor();
    const files = {
      triage: {
        "triage.json": JSON.stringify({
          disposition: "proceed",
          type: "bug",
          risk: "low",
          done_when: "x",
          files_expected: ["a"],
          gate_level: "make check",
          confidence: 0.9,
        }),
      },
      plan: {
        "plan-comment.md": "<!-- factory:plan v1 rev=1 -->\nplan",
        "plan.json": JSON.stringify({ risk: "low", revision: 1, files: ["a"], autoApproveEligible: true }),
      },
      build: { "build.json": JSON.stringify({ status: "green", gate_line: "ok", rounds: 1 }) },
      verify: { "verdict.json": JSON.stringify({ result: "pass", rounds: 1, findings: [] }) },
      pr: { "pr-body.md": "Closes #1" },
    } as const;
    for (const [stage, f] of Object.entries(files))
      executor.push(stage as keyof typeof files, 1, fixtureFor(stage as keyof typeof files, 1), f);
    const deps = {
      github,
      git: new FakeGit(),
      state,
      executor,
      gateRunner: new FakeGateRunner(),
      holdoutRunner: new FakeHoldoutRunner(),
      cloneDir: home,
      workspacesDir: home,
      view,
      runFiles: { transcript: (n: number) => join(home, `t-${n}.log`), live: (n: number) => join(home, `l-${n}.json`) },
    };
    const outcome = await processReadyIssue(github.issues.get(1)!, deps, mergeConfig({ repo: "acme/widgets" }));
    expect(outcome).toBe("shipped");
    expect(shown).toEqual([1, 1, 1, 1, 1]);
    await Bun.sleep(0);
    expect(closed).toEqual([1]);
    state.close();
    rmSync(home, { recursive: true, force: true });
  });
});
