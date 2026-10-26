// Every step type a workflow's `uses:` can name: the five stages and `check` from steps.ts, plus
// the ones the library workflows need. `tool` calls one MCP tool with no agent and `report` ends
// a workflow that opens no PR. Only the runner acts here, so agent stages stay read-only.

import { LABEL } from "../labels";
import { callMcpTool } from "../mcp-call";
import { ShellSetupRunner } from "../setup";
import { finish, moveLabel, postComment } from "./common";
import { STEP_TYPES, type StepCtx, type StepResult, type StepType } from "./steps";

const stop = (outcome: "failed" | "shipped"): StepResult => ({ kind: "stop", outcome });

// `{{issue.number}}` and `{{issue.title}}` in a tool's arguments, so a cron issue can name itself.
function fill(v: unknown, sc: StepCtx): unknown {
  if (typeof v === "string")
    return v
      .replace(/\{\{issue\.number\}\}/g, String(sc.issue.number))
      .replace(/\{\{issue\.title\}\}/g, sc.issue.title);
  if (Array.isArray(v)) return v.map((x) => fill(x, sc));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, sc)]));
  return v;
}

async function failStep(sc: StepCtx, why: string, tail: string): Promise<StepResult> {
  const { deps, config, issue, step } = sc;
  await postComment(
    deps,
    config,
    issue.number,
    `Step \`${step.id}\` failed: ${why}.\n\n\`\`\`\n${tail.slice(-4000)}\n\`\`\``,
    {
      stage: step.id,
      json: { ok: false },
    },
  );
  await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
  finish(deps, config, issue.number, "failed", `${step.id}: ${why}`);
  return stop("failed");
}

const tool: StepType = {
  tool: true,
  async run(sc) {
    const { step, deps } = sc;
    let last = { ok: false, text: "" };
    for (let attempt = 0; attempt <= (step.retries ?? 0); attempt++) {
      last = await callMcpTool(deps.cloneDir, step.tool!, fill(step.with ?? {}, sc) as Record<string, unknown>);
      if (last.ok) return { kind: "next", facts: { ok: true, text: last.text } };
    }
    return failStep(sc, `\`${step.tool}\` returned an error`, last.text);
  },
};

const report: StepType = {
  terminal: true,
  async run(sc) {
    const { deps, config, issue, step, workflow } = sc;
    await postComment(
      deps,
      config,
      issue.number,
      `The \`${workflow.name}\` workflow finished; its findings are in the comments above.`,
      {
        stage: step.id,
        json: { ok: true },
      },
    );
    await deps.github.removeLabels(config.repo, issue.number, [step.label]);
    await deps.github.closeIssue(config.repo, issue.number);
    finish(deps, config, issue.number, "shipped");
    return stop("shipped");
  },
};

// A check with `retries:` reruns quietly; only the last attempt parks the issue with its tail.
const check: StepType = {
  ...STEP_TYPES.check!,
  async run(sc) {
    for (let attempt = 0; attempt < (sc.step.retries ?? 0); attempt++) {
      const name = sc.step.runtime ?? sc.config.runtime?.check;
      const runtime = name ? sc.deps.runtimes?.[name] : (sc.deps.setupRunner ?? new ShellSetupRunner());
      if (runtime && (await runtime.run(sc.step.run!, sc.worktree)).code === 0)
        return { kind: "next", facts: { ok: true } };
    }
    return STEP_TYPES.check!.run(sc);
  },
};

export const ALL_STEP_TYPES: Readonly<Record<string, StepType>> = { ...STEP_TYPES, check, tool, report };
