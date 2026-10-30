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
  const applied = await loadConfigExplained(await cli.resolveCloneDir());
  const issue = await makeScm(applied.config).getIssue(applied.config.repo, n);
  const type = issueType(
    applied.config.routes,
    issue.labels.map((l) => l.name),
  );
  for (const line of explainLines({ issue: n, repo: applied.config.repo, type, applied })) console.log(line);
}
