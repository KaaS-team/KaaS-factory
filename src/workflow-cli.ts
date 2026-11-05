// `factory workflow show <name>` and `factory workflow run <name> --issue <N> --preview`.

import { EXIT, UsageError, successJson } from "./cli-output";
import { loadConfig } from "./config";
import { loadWorkflow } from "./engine/workflows";
import { LABEL } from "./labels";
import { previewDeps, type PreviewWrite } from "./workflow-preview";
import { processReadyIssue } from "./watch";
import type { CliContext } from "./harness-cli";

export const WORKFLOW_USAGE = "usage: factory workflow (show <name> | run <name> --issue <N> --preview) [--json]";

export function formatPreview(outcome: string, writes: readonly PreviewWrite[]): string[] {
  const out = [`factory workflow: preview ended ${outcome}; ${writes.length} write(s) not made`];
  for (const w of writes) out.push(`  would ${w.op} -> ${w.target}`, ...(w.body ? [indent(w.body)] : []));
  return out;
}
const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

export async function cmdWorkflow(c: CliContext): Promise<void> {
  const [, sub, name] = c.args;
  if ((sub !== "show" && sub !== "run") || !name || name.startsWith("--")) throw new UsageError(WORKFLOW_USAGE);
  if (sub === "run" && !c.has("preview"))
    throw new UsageError("workflow run: only --preview is supported; pass --preview");
  const cloneDir = await c.cloneDir();
  const loaded = await loadWorkflow(cloneDir, name);
  if (!loaded.ok) {
    for (const p of loaded.problems) console.log(`factory workflow: ${p}`);
    process.exit(EXIT.checksFailed);
  }
  if (sub === "show") {
    console.log(JSON.stringify(loaded.workflow, null, 2));
    return;
  }
  const issueNumber = Number(c.flag("issue"));
  if (!issueNumber) throw new UsageError("workflow run: --issue <N> is required");
  const config = await loadConfig(cloneDir);
  const real = await c.watchDeps(cloneDir, config);
  const writes: PreviewWrite[] = [];
  const deps = previewDeps({ ...(real as object), workflow: loaded.workflow } as never, writes);
  const issue = await deps.github.getIssue(config.repo, issueNumber);
  const ready = { ...issue, labels: [...issue.labels, { name: LABEL.ready }] } as typeof issue;
  const outcome = await processReadyIssue(ready, deps, config);
  if (c.has("json")) console.log(successJson({ preview: true, issue: issueNumber, outcome, writes }, true));
  else for (const line of formatPreview(outcome, writes)) console.log(line);
}
