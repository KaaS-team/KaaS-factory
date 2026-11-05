// `factory send <N> <words>`: say something to the run working on #N. The cockpit composer posts the
// same message through sendToRun (integrations/steer.ts), so both reach the agent the same way.

import { UsageError, successJson } from "./cli-output";
import { sendToRun } from "./integrations/steer";
import { appendMessage, worktreeOf } from "./run-messages";
import { repoOf } from "./remote-cli";

export async function cmdSend(argv: readonly string[]): Promise<void> {
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--json") continue;
    if (argv[i]!.startsWith("--")) i++;
    else words.push(argv[i]!);
  }
  const issue = Number((words.shift() ?? "").replace(/^#/, ""));
  if (!Number.isInteger(issue) || issue < 1 || !words.length)
    throw new UsageError("send: factory send <N> <words> (--repo <owner/name> | --repo-dir <path>)");
  const { repo } = await repoOf(argv, "send");
  const by = process.env.USER ?? "operator";
  const line = {
    deliver: (n: number, text: string) => appendMessage(worktreeOf(repo, n), n, text, by),
  };
  await sendToRun(line, issue, words.join(" "), by);
  console.log(argv.includes("--json") ? successJson({ issue, sent: true }, true) : `#${issue}: sent`);
}
