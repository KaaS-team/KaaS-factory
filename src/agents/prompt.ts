// The prompt a non-Claude agent receives: the stage skill's body, then the
// artifact contract. Any agent that can write a file can do a stage, so the
// contract is the only interface. Claude runs `/factory-<stage> N` itself.
// Shape after owainlewis/machinist@3943516 internal/runner/runner.go:220 (the contract suffix).

import { readFile } from "node:fs/promises";
import { COMMENT_FILENAMES, JSON_FILENAMES, runDir } from "../artifacts";
import { stageSchema } from "../schemas";
import type { StageRunOptions } from "../executor";

export function stripFrontmatter(text: string): string {
  return text.startsWith("---\n") ? text.slice(text.indexOf("\n---", 3) + 4).replace(/^\n+/, "") : text;
}

// `types` bounds the triage schema's `type` enum to the repo's actual type
// list (typesFor(config.routes)); omitted, it falls back to TYPE_LABELS.
export function artifactContract(
  opts: Pick<StageRunOptions, "stage" | "issue">,
  readOnly = false,
  types?: readonly string[],
): string {
  if (readOnly) {
    return [
      "## Artifact contract",
      "",
      "This stage is read-only: you cannot write files. Do not try. Your final message must be ONE JSON object and nothing else, with no code fence:",
      `{"artifact": <the structured result, exactly as the instructions above describe for ${JSON_FILENAMES[opts.stage]}>, "comment": "<the comment the runner posts on the issue, in markdown>", "question": "<only when you cannot proceed without a human answer>"}`,
      "",
      `The artifact must match this JSON Schema: ${JSON.stringify(stageSchema(opts.stage, types))}`,
      "",
      "You have no GitHub access and cannot push or merge; the runner does that.",
    ].join("\n");
  }
  return [
    "## Artifact contract",
    "",
    `You run in the issue's worktree. Write your results as files in $FACTORY_ARTIFACT_DIR (${runDir(opts.issue)}/):`,
    `- ${JSON_FILENAMES[opts.stage]}: the structured result, exactly as the instructions above describe. Schema: ${JSON.stringify(stageSchema(opts.stage, types))}`,
    `- ${COMMENT_FILENAMES[opts.stage]}: the comment the runner posts on the issue.`,
    "- question-comment.md: only when you cannot proceed without an answer from a human.",
    "",
    "You have no GitHub access and cannot push or merge; the runner does that. Finish by exiting.",
  ].join("\n");
}

// `contextPack` (buildContextPack, plan v2.7.0 item 3) is inlined here for
// every non-Claude agent; Claude gets the same text through
// --append-system-prompt instead (see agents/presets/claude.ts).
export async function renderPrompt(
  opts: StageRunOptions,
  readOnly = false,
  types?: readonly string[],
  contextPack = "",
): Promise<string> {
  const skill = await readFile(`${opts.cwd}/.claude/skills/factory-${opts.stage}/SKILL.md`, "utf8").catch(() => {
    throw new Error(
      `stage skill .claude/skills/factory-${opts.stage}/SKILL.md not found in ${opts.cwd}; run \`factory install --update\``,
    );
  });
  return [
    `Stage: ${opts.stage}. Issue number: ${opts.issue}. Wherever the instructions say <N>, use ${opts.issue}.`,
    "",
    stripFrontmatter(skill).trim(),
    "",
    ...(contextPack ? [contextPack, ""] : []),
    artifactContract(opts, readOnly, types),
    "",
  ].join("\n");
}
