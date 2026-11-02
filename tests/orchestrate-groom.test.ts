import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config";
import { closingLine } from "../src/engine/epic";
import { LABEL } from "../src/labels";
import { orchestrateOf } from "../src/orchestrate/config";
import { groomIssue, groomPrompt } from "../src/orchestrate/groom";
import { FactoryState } from "../src/state";
import { validBody } from "./plan-guard.test";
import { assertCustomerSafe, baseIssue, FakeGitHub } from "./harness";
import type { GhIssue } from "../src/github";
import type { StageRunOptions, StageRunResult } from "../src/executor";

const GROOM_MODEL = "fake-groom-model-id";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

type Call =
  | { kind: "editIssueBody"; number: number; body: string }
  | { kind: "removeLabels"; number: number; labels: string[] }
  | { kind: "addLabels"; number: number; labels: string[] }
  | { kind: "commentIssue"; number: number; body: string };

class RecordingGitHub extends FakeGitHub {
  calls: Call[] = [];

  override async editIssueBody(_repo: string, number: number, body: string): Promise<void> {
    this.calls.push({ kind: "editIssueBody", number, body });
    await super.editIssueBody(_repo, number, body);
  }

  override async removeLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    this.calls.push({ kind: "removeLabels", number, labels: [...labels] });
    await super.removeLabels(_repo, number, labels);
  }

  override async addLabels(_repo: string, number: number, labels: string[]): Promise<void> {
    this.calls.push({ kind: "addLabels", number, labels: [...labels] });
    await super.addLabels(_repo, number, labels);
  }

  override async commentIssue(_repo: string, number: number, body: string): Promise<number> {
    this.calls.push({ kind: "commentIssue", number, body });
    return super.commentIssue(_repo, number, body);
  }

  override async labeledBy(_repo: string, number: number): Promise<string | undefined> {
    return this.labelers.has(number) ? this.labelers.get(number) : "maintainer";
  }
}

class FakeGroomExecutor {
  readonly runs: StageRunOptions[] = [];
  answer = "";
  exitCode = 0;

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.runs.push(opts);
    return {
      events: [],
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      exitCode: this.exitCode,
      permissionDenials: [],
      finalMessage: this.answer,
    };
  }
}

function factoryConfig(extra?: Parameters<typeof mergeConfig>[0]) {
  return mergeConfig({
    repo: "acme/widgets",
    agents: { claude: { command: ["true"] } },
    stages: { plan: "claude", default: "claude" },
    agentCommands: { read: [], build: ["make *"], verify: ["make *"] },
    orchestrate: { groom: { label: "needs-plan", model: GROOM_MODEL, epicMinutes: 120 } },
    ...extra,
  });
}

function setup(issues: GhIssue[], executor = new FakeGroomExecutor()) {
  mkdirSync(tmpdir(), { recursive: true });
  const cloneDir = mkdtempSync(join(tmpdir(), "groom-clone-"));
  dirs.push(cloneDir);
  const github = new RecordingGitHub(issues);
  const config = factoryConfig();
  const deps = {
    github,
    executor,
    state: new FactoryState(":memory:"),
    cloneDir,
  };
  return { github, executor, deps, config };
}

function groomCalls(calls: Call[]) {
  return calls.filter((c) => c.kind !== "commentIssue" || c.number === 1);
}

describe("groomIssue", () => {
  test("groomed in order", async () => {
    const body = await validBody();
    const executor = new FakeGroomExecutor();
    executor.answer = body;
    const issue = baseIssue(1, ["needs-plan"]);
    const { github, deps, config } = setup([issue], executor);
    expect(await groomIssue(deps, config, issue)).toBe("groomed");
    const kinds = groomCalls(github.calls)
      .filter((c) => c.number === 1)
      .map((c) => c.kind);
    expect(kinds).toEqual(["editIssueBody", "removeLabels", "addLabels"]);
    const ready = github.calls.find((c) => c.kind === "addLabels" && c.number === 1);
    if (ready?.kind !== "addLabels") throw new Error("expected addLabels");
    expect(ready.labels).toEqual([LABEL.ready]);
  });

  test("guard blocks writes", async () => {
    const executor = new FakeGroomExecutor();
    executor.answer = "<!-- factory:planned v1 -->\n".padEnd(200, "x");
    const issue = baseIssue(1, ["needs-plan"]);
    const { github, deps, config } = setup([issue], executor);
    expect(await groomIssue(deps, config, issue)).toBe("parked");
    expect(github.calls.some((c) => c.kind === "editIssueBody")).toBe(false);
    const park = github.calls.find((c) => c.kind === "addLabels" && c.number === 1);
    if (park?.kind !== "addLabels") throw new Error("expected addLabels");
    expect(park.labels).toEqual([LABEL.needsHuman]);
  });

  test("trust", async () => {
    const executor = new FakeGroomExecutor();
    executor.answer = await validBody();
    const issue = baseIssue(1, ["needs-plan"]);
    const { github, deps, config } = setup([issue], executor);
    github.labelers.set(1, "drive-by");
    github.roles.set("drive-by", "read");
    expect(await groomIssue(deps, config, issue)).toBe("skipped");
    expect(executor.runs.length).toBe(0);
  });

  test("epic too big", async () => {
    const executor = new FakeGroomExecutor();
    const epic = baseIssue(1, ["needs-plan"]);
    epic.body = "- [ ] #2\n- [ ] #3\n- [ ] #4";
    const child = (n: number) => {
      const i = baseIssue(n, ["size:L"]);
      i.body = `## Files\n\`src/x${n}.ts\``;
      return i;
    };
    const { github, deps, config } = setup([epic, child(2), child(3), child(4)], executor);
    const orch = orchestrateOf(config);
    const capped = factoryConfig({
      orchestrate: { groom: { label: "needs-plan", model: GROOM_MODEL, epicMinutes: 120 } },
    });
    expect(await groomIssue(deps, capped, epic)).toBe("parked");
    expect(executor.runs.length).toBe(0);
    const note = github.calls.find((c) => c.kind === "commentIssue" && c.number === 1);
    if (note?.kind !== "commentIssue") throw new Error("expected comment");
    expect(note.body).toContain("Unit 1:");
    expect(note.body).toContain("#2");
    expect(orch.groom.epicMinutes).toBe(120);
  });

  test("epic prompt", async () => {
    const body = await validBody();
    const executor = new FakeGroomExecutor();
    executor.answer = body;
    const epic = baseIssue(5, ["needs-plan"]);
    epic.body = "- [ ] #6\n- [ ] #7";
    const c6 = baseIssue(6, ["size:S"]);
    c6.title = "Child six title";
    c6.body = "six body";
    const c7 = baseIssue(7, ["size:S"]);
    c7.title = "Child seven title";
    c7.body = "seven body";
    const { executor: ex, deps, config } = setup([epic, c6, c7], executor);
    expect(await groomIssue(deps, config, epic)).toBe("groomed");
    const run = ex.runs[0];
    if (run === undefined) throw new Error("expected run");
    expect(run.prompt).toContain("Child six title");
    expect(run.prompt).toContain("Child seven title");
    expect(run.prompt).toContain(closingLine(5, [6, 7]));
  });

  test("neutral", async () => {
    const executor = new FakeGroomExecutor();
    executor.answer = await validBody();
    const issue = baseIssue(1, ["needs-plan"]);
    const { github, deps, config } = setup([issue], executor);
    await groomIssue(deps, config, issue);
    for (const c of github.calls) {
      if (c.kind !== "commentIssue") continue;
      expect(c.body.includes(GROOM_MODEL)).toBe(false);
      expect(c.body.toLowerCase().includes("cost")).toBe(false);
      assertCustomerSafe(c.body);
    }
  });

  test("read-only stage", async () => {
    const executor = new FakeGroomExecutor();
    executor.answer = await validBody();
    const issue = baseIssue(1, ["needs-plan"]);
    const { executor: ex, deps, config } = setup([issue], executor);
    await groomIssue(deps, config, issue);
    const run = ex.runs[0];
    if (run === undefined) throw new Error("expected run");
    expect(run.stage).toBe("plan");
    expect(run.model).toBe(orchestrateOf(config).groom.model);
  });
});

describe("groomPrompt", () => {
  test("epic prompt includes children", () => {
    const prompt = groomPrompt({ number: 5, title: "Epic", body: "- [ ] #6" }, [
      { number: 6, title: "Child six title", body: "six" },
    ]);
    expect(prompt).toContain("Child six title");
    expect(prompt).toContain(closingLine(5, [6]));
  });
});
