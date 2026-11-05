// `uses: cli`: runs one declared CLI tool with no agent and no tokens. `run: <name> [args...]` names a
// tool in the base checkout's .factory/cli-tools.json; the rest of the line is its extra arguments,
// split on spaces and passed with no shell. The tool's output is the step's fact (`text`), so a later
// edge's `if:` and the next step can read it. An undeclared name, a failing command or output that
// misses the declared expectation parks the issue failed, the way a red `check` step does.

import { CliToolError, runCliTool } from "../cli-tools";
import { LABEL } from "../labels";
import { finish, moveLabel, postComment } from "./common";
import type { StepResult, StepType } from "./steps";

const OUTPUT_CAP = 20_000;

export const cliStep: StepType = {
  command: true,
  async run({ deps, config, issue, step }): Promise<StepResult> {
    const [name = "", ...args] = step.run!.trim().split(/\s+/);
    let why: string;
    let tail = "";
    try {
      const r = await runCliTool(deps.cloneDir, name, args);
      const text = r.stdout.slice(0, OUTPUT_CAP);
      if (r.ok) return { kind: "next", facts: { ok: true, tool: name, code: r.code, text } };
      why = `the CLI tool \`${name}\` ${r.reason}`;
      tail = `${r.stdout}${r.stderr}`;
    } catch (e) {
      if (!(e instanceof CliToolError)) throw e;
      why = e.message;
    }
    await postComment(
      deps,
      config,
      issue.number,
      `Step \`${step.id}\` failed: ${why}.${tail ? `\n\n\`\`\`\n${tail.slice(-4000)}\n\`\`\`` : ""}`,
      { stage: step.id, json: { ok: false } },
    );
    await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
    finish(deps, config, issue.number, "failed", `${step.id}: ${why}`);
    return { kind: "stop", outcome: "failed" };
  },
};
