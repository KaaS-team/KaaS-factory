import { successJson } from "./cli-output";
import { loadConfig } from "./config";
import { type CommandRunner, GhCommandRunner } from "./github";
import { type Group, type OutcomeReport, outcomeReport } from "./outcomes";
import { type OutcomeLedger, readOutcomes } from "./outcomes-read";
import { FactoryState, type StageRun } from "./state";

const USAGE = "usage: factory metrics [--since <date>] [--until <date>] [--json]";

// Sums each issue's stage runs; one unknown cost makes the issue's cost unknown.
export function ledgerOf(stages: readonly StageRun[]): OutcomeLedger {
  return {
    costOf(issue) {
      const rows = stages.filter((s) => s.issue === issue);
      if (!rows.length) return undefined;
      return rows.some((s) => s.cost_usd === null) ? null : rows.reduce((n, s) => n + s.cost_usd!, 0);
    },
  };
}

const usd = (n: number | undefined) => (n === undefined ? "unknown" : `$${n.toFixed(2)}`);
const row = (g: Group) =>
  `  ${g.name}  accepted ${g.accepted}, not kept ${g.rejected}, cost per accepted outcome ${usd(g.costPerAccepted)}`;

export function formatOutcomes(r: OutcomeReport): string {
  const lines = ["workflows:", ...r.workflows.map(row), "teams:", ...r.teams.map(row)];
  for (const v of r.variants)
    lines.push(
      `variants of ${v.workflow}${v.cheapest ? ` (lowest cost: ${v.cheapest})` : ""}:`,
      ...v.variants.map(row),
    );
  return lines.join("\n");
}

const validDate = (s: string | undefined, name: string) => {
  if (s !== undefined && Number.isNaN(Date.parse(s))) throw new Error(`--${name} "${s}" is not a date; ${USAGE}`);
  return s;
};

// `factory metrics`: what each workflow's work came to in the repo, and what it cost per kept outcome.
export async function cmdMetrics(
  cli: { flag(name: string): string | undefined; has(name: string): boolean },
  deps: { runner: CommandRunner; repo: string; defaultWorkflow: string; stages: readonly StageRun[] },
): Promise<void> {
  const window = { since: validDate(cli.flag("since"), "since"), until: validDate(cli.flag("until"), "until") };
  const outcomes = await readOutcomes(deps.runner, deps.repo, {
    defaultWorkflow: deps.defaultWorkflow,
    ledger: ledgerOf(deps.stages),
  });
  const report = outcomeReport(outcomes, window);
  console.log(cli.has("json") ? successJson(report) : formatOutcomes(report));
}

// Outcomes come from GitHub and costs from this machine's stage ledger.
export async function cmdMetricsRun(
  cli: Parameters<typeof cmdMetrics>[0] & { resolveCloneDir(): Promise<string> },
  statePath: (repo: string) => string,
): Promise<void> {
  const config = await loadConfig(await cli.resolveCloneDir());
  await cmdMetrics(cli, {
    runner: new GhCommandRunner(),
    repo: config.repo,
    defaultWorkflow: config.workflow,
    stages: new FactoryState(statePath(config.repo)).listStageRuns(config.repo, { limit: 100_000 }),
  });
}
