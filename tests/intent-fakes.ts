// A fake agent for the intent stages: each config.agents name answers with its own scripted
// final message, with no process, network or model. It records which agent ran which prompt.
import { aggregateStageEvents } from "../src/executor";
import type { Executor, StageRunOptions, StageRunResult } from "../src/ports/agent";

export class ScriptedAgents implements Executor {
  readonly calls: StageRunOptions[] = [];
  constructor(
    private readonly replies: Record<string, unknown>,
    private readonly exitCode = 0,
  ) {}

  async runStage(opts: StageRunOptions): Promise<StageRunResult> {
    this.calls.push(opts);
    const reply = this.replies[opts.agent ?? ""];
    if (reply === undefined) throw new Error(`no scripted reply for agent ${opts.agent}`);
    const finalText = typeof reply === "string" ? reply : JSON.stringify(reply);
    return aggregateStageEvents([{ kind: "result", finalText }], this.exitCode);
  }
}

export const SPEC = {
  slug: "12-csv-export",
  markdown: [
    "# CSV export",
    "",
    "Finance re-types the totals table into a spreadsheet each month.",
    "",
    "AC-1: The totals page has a Download CSV button.",
    "AC-2: The CSV has one row per invoice with its total in cents.",
    "AC-3: An empty month downloads a CSV with only the header row.",
  ].join("\n"),
};

export const TICKETS = {
  tickets: [
    { key: "t1", title: "Totals as CSV rows", body: "Render invoices as CSV.", acs: ["AC-2", "AC-3"], blockedBy: [] },
    { key: "t2", title: "Download CSV button", body: "Add the button.", acs: ["AC-1"], blockedBy: ["t1"] },
  ],
};
