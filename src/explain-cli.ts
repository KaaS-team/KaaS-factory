// `factory explain <N>`: which level set each config key for issue N.
import { UsageError } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { loadConfigExplained } from "./config";
import { issueType } from "./labels";
import { makeScm } from "./scm";
import { explainLines } from "./team/explain";

export async function cmdExplain(cli: CliContext): Promise<void> {
  const n = Number(cli.args[1]);
  if (!Number.isInteger(n) || n <= 0)
    throw new UsageError("explain: usage: factory explain <N> (--repo-dir <path> | --repo <owner/name>)");
  const dir = await cli.resolveCloneDir();
  const first = await loadConfigExplained(dir);
  const issue = await makeScm(first.config).getIssue(first.config.repo, n);
  // Teams that share a repo are told apart by the issue's labels.
  const applied = await loadConfigExplained(dir, {
    issue: { labels: issue.labels.map((l) => l.name), paths: [] },
  });
  const type = issueType(
    applied.config.routes,
    issue.labels.map((l) => l.name),
  );
  for (const line of explainLines({ issue: n, repo: applied.config.repo, type, applied })) console.log(line);
}
