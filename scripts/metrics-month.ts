// Writes the factory's metrics for one calendar month (dashboard/metrics-month.ts) from the state DB
// of each --repo plus two counts read with gh; the state DB lives on the operator's machine.
//   bun scripts/metrics-month.ts --repo owner/name [--repo ...] --month YYYY-MM [--out metrics.md]

import { writeFileSync } from "node:fs";
import { metricsMarkdown, monthMetrics } from "../dashboard/metrics-month";
import { defaultStatePath } from "../src/paths";
import { FactoryState } from "../src/state";

const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const repos = values("--repo");
const month = values("--month")[0] ?? "";
if (!repos.length || !/^\d{4}-\d{2}$/.test(month)) {
  console.error(
    "usage: bun scripts/metrics-month.ts --repo owner/name [--repo ...] --month YYYY-MM [--out metrics.md]",
  );
  process.exit(2);
}
const [y, m] = month.split("-").map(Number) as [number, number];
const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
const range = `${month}-01..${month}-${String(last).padStart(2, "0")}`;

function count(kind: "prs" | "issues", repo: string, flag: string, query: string): number {
  const r = Bun.spawnSync([
    "gh",
    "search",
    kind,
    "--repo",
    repo,
    flag,
    range,
    query,
    "--json",
    "number",
    "--limit",
    "1000",
  ]);
  if (r.exitCode !== 0) {
    console.error(`metrics-month: gh search ${kind} failed for ${repo}: ${r.stderr.toString().trim()}`);
    process.exit(1);
  }
  return (JSON.parse(r.stdout.toString()) as unknown[]).length;
}

const counts = { reverts: 0, escaped: 0 };
for (const repo of repos) {
  counts.reverts += count("prs", repo, "--merged", "Revert in:title");
  counts.escaped += count("issues", repo, "--created", '"Escaped defect:" in:title');
}
const sources = repos.map((repo) => ({ state: new FactoryState(defaultStatePath(process.env, repo)), repo }));
const md = metricsMarkdown(monthMetrics(sources, month, counts));
const out = values("--out")[0];
if (out) writeFileSync(out, md);
else process.stdout.write(md);
