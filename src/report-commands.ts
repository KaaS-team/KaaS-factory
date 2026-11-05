import type { CliContext } from "./cli-runtime";

// Read-only commands loaded on demand, so cli.ts keeps one case for the group.
export async function runReportCommand(
  name: string,
  cli: Pick<CliContext, "args" | "flag" | "has" | "resolveCloneDir">,
  statePath: (repo: string) => string,
): Promise<void> {
  if (name === "receipt") return (await import("./receipt-cli")).cmdReceipt(cli as CliContext);
  if (name === "hotspots") return (await import("./hotspots-cli")).cmdHotspots(cli as CliContext);
  return (await import("./metrics-cli")).cmdMetricsRun(cli, statePath);
}
