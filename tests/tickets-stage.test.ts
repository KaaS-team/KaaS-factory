// The tickets stage: a checked spec becomes issues whose "Blocked by" lines form a DAG covering every
// criterion, and the whole intent-to-tickets run uses a different agent for each stage.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "../src/agents/executor";
import { blockerNumbers } from "../src/blockers";
import { mergeConfig } from "../src/config";
import { intentToTickets } from "../src/intent/pipeline";
import { fileTickets, findCycle, runTicketsStage, type Ticket, ticketProblems } from "../src/intent/tickets";
import { LABEL } from "../src/labels";
import { FakeGitHub } from "./harness";
import { SPEC, ScriptedAgents, TICKETS } from "./intent-fakes";

const scratch = mkdtempSync(join(tmpdir(), "factory-tickets-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const t = (key: string, acs: string[], blockedBy: string[] = [], title = `Ticket ${key}`): Ticket => ({
  key,
  title,
  body: "Do it.",
  acs,
  blockedBy,
});
const stage = (executor: ScriptedAgents | CommandExecutor, agent: string, cwd = scratch) => ({
  executor,
  agent,
  cwd,
  maxBudgetUsd: 1,
});

describe("tickets stage", () => {
  test("a spec becomes issues with blocking edges, blockers filed first", async () => {
    const out = await runTicketsStage(stage(new ScriptedAgents({ splitter: TICKETS }), "splitter"), SPEC);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const github = new FakeGitHub([]);
    const filed = await fileTickets(github, "acme/widgets", SPEC, out.value, [LABEL.ready]);
    expect(filed).toEqual([
      { key: "t1", number: 1, blockedBy: [] },
      { key: "t2", number: 2, blockedBy: [1] },
    ]);
    const second = await github.getIssue("acme/widgets", 2);
    expect(blockerNumbers(second.body)).toEqual([1]);
    expect(second.body).toContain("Acceptance: specs/12-csv-export.md AC-1");
    expect(second.body).toContain("Holdouts: holdout/12-csv-export/AC-1.*");
    expect(blockerNumbers((await github.getIssue("acme/widgets", 1)).body)).toEqual([]);
  });

  test("the ticket check rejects a criterion no ticket covers", () => {
    expect(ticketProblems(SPEC, [t("a", ["AC-1"]), t("b", ["AC-2"])])).toEqual(["AC-3 is covered by no ticket"]);
  });

  test("the ticket check rejects a cycle in the blocking edges", () => {
    const tickets = [t("a", ["AC-1"], ["c"]), t("b", ["AC-2"], ["a"]), t("c", ["AC-3"], ["b"])];
    expect(ticketProblems(SPEC, tickets)).toEqual(["the blocking edges have a cycle: a -> c -> b -> a"]);
    expect(findCycle([t("a", ["AC-1"], ["a"])])).toEqual(["a", "a"]);
    expect(findCycle([t("a", ["AC-1"]), t("b", ["AC-2"], ["a"]), t("c", ["AC-3"], ["a", "b"])])).toBeUndefined();
  });

  test("the ticket check rejects a ticket that covers no criterion", () => {
    expect(ticketProblems(SPEC, [t("a", ["AC-1", "AC-2", "AC-3"]), t("b", [])])).toEqual([
      "ticket b covers no acceptance criterion",
    ]);
  });

  test("the ticket check rejects a duplicate ticket", () => {
    const all = ["AC-1", "AC-2", "AC-3"];
    expect(ticketProblems(SPEC, [t("a", all), t("a", ["AC-1"], [], "Other")])).toEqual(["ticket a is listed twice"]);
    expect(ticketProblems(SPEC, [t("a", all, [], "Same"), t("b", ["AC-1"], [], " same ")])).toEqual([
      'ticket b duplicates the title " same "',
    ]);
  });

  test("the ticket check rejects an unknown criterion, an edge to nowhere and an empty list", () => {
    expect(ticketProblems(SPEC, [t("a", ["AC-1", "AC-2", "AC-3", "AC-9"], ["zz"])])).toEqual([
      "ticket a names AC-9, which the spec does not have",
      "ticket a is blocked by zz, which is no ticket",
    ]);
    expect(ticketProblems(SPEC, [])).toContain("there are no tickets");
  });

  test("a bad graph files no issue at all", async () => {
    const github = new FakeGitHub([]);
    const cyclic = [t("a", ["AC-1", "AC-2"], ["b"]), t("b", ["AC-3"], ["a"])];
    await expect(fileTickets(github, "acme/widgets", SPEC, cyclic, [])).rejects.toThrow("cycle");
    expect(await github.listOpenIssues("acme/widgets")).toEqual([]);
  });

  test("the stage fails on a failed agent and on an answer that is not a ticket list", async () => {
    const failed = await runTicketsStage(stage(new ScriptedAgents({ s: TICKETS }, 2), "s"), SPEC);
    expect(failed.ok ? [] : failed.problems).toEqual(["the tickets agent exited 2"]);
    const shape = await runTicketsStage(stage(new ScriptedAgents({ s: { tickets: [{ key: 1 }] } }), "s"), SPEC);
    expect(shape.ok ? [] : shape.problems).toEqual(['the tickets agent did not answer {"tickets": [...]}']);
  });

  test("intent to tickets refuses one agent for both stages", async () => {
    const agents = new ScriptedAgents({ same: SPEC });
    const out = await intentToTickets(
      { spec: stage(agents, "same"), tickets: stage(agents, "same"), scm: new FakeGitHub([]), repo: "a/b", labels: [] },
      "Let finance download the totals as CSV",
    );
    expect(out).toEqual({
      ok: false,
      stage: "tickets",
      problems: ['the spec and tickets stages both name agent "same"'],
    });
    expect(agents.calls).toEqual([]);
  });

  test("intent to spec to tickets: two different ACP agents through the factory's executor", async () => {
    const cwd = mkdtempSync(join(scratch, "repo-"));
    const fixture = (f: string) => join(import.meta.dir, "fixtures/agents", f);
    const specReply = join(scratch, "spec.json");
    const ticketsReply = join(scratch, "tickets.json");
    writeFileSync(specReply, JSON.stringify(SPEC));
    writeFileSync(ticketsReply, JSON.stringify(TICKETS));
    const config = mergeConfig({
      repo: "acme/widgets",
      agents: {
        author: { preset: "acp", command: ["python3", fixture("fake-acp.py"), specReply] },
        splitter: { preset: "acp", command: [process.execPath, fixture("fake-acp.ts"), ticketsReply] },
      },
      stages: { default: "author" },
    });
    const executor = new CommandExecutor(config.agents, config.stages);
    const github = new FakeGitHub([]);
    const out = await intentToTickets(
      {
        spec: stage(executor, "author", cwd),
        tickets: stage(executor, "splitter", cwd),
        scm: github,
        repo: "acme/widgets",
        labels: [LABEL.ready],
      },
      "Let finance download the totals as CSV",
    );
    expect(out.ok ? out.filed.map((f) => [f.number, f.blockedBy]) : out).toEqual([
      [1, []],
      [2, [1]],
    ]);
    expect(existsSync(join(cwd, "specs/12-csv-export.md"))).toBe(true);
    expect(readFileSync(join(cwd, "specs/12-csv-export.md"), "utf8")).toContain("AC-3: An empty month");
    expect((await github.getIssue("acme/widgets", 2)).labels.map((l) => l.name)).toEqual([LABEL.ready]);
  }, 30_000);
});
