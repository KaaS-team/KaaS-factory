// `factory teach "<how we ship>"`: one agent run in a fresh clone reads the repo, its CI and the
// company brain (an MCP server named "brain"), and answers with workflows, minions and skills. Each
// file is checked by the watcher's own parser, then goes out as one PR; nothing writes the repo.

import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { outsideAllowedPaths } from "./boundary";
import type { FactoryConfig } from "./config";
import { parseMinion, type Minion } from "./core/minion";
import { type MinionDeps, runMinion } from "./engine/minion";
import { parseWorkflowText } from "./engine/workflows";
import { readRegistry } from "./mcp";
import { type ProposeDeps, proposeFiles } from "./propose-pr";

export const TEACH_ALLOWED = [".factory/workflows/**", ".factory/minions/**", ".claude/skills/**"] as const;

export type TeachDeps = MinionDeps & ProposeDeps;

export type TeachResult =
  | { readonly prUrl: string; readonly branch: string; readonly files: readonly string[] }
  | { readonly problems: readonly string[] };

const ciFiles = (cloneDir: string): string[] => {
  try {
    return readdirSync(join(cloneDir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    return [];
  }
};

export function teachPrompt(how: string, ci: readonly string[], brain: boolean): string {
  return [
    "You are setting up KaaS Factory for this repository. The team describes how they ship:",
    "",
    `<how-we-ship>\n${how.replace(/</g, "&lt;")}\n</how-we-ship>`,
    "",
    "Read the code, the README, the bundled workflows in .factory/workflows/ and the CI in .github/workflows/",
    `(${ci.length ? ci.join(", ") : "none found"}).${brain ? " Ask the brain MCP server how the company ships and reviews work." : ""}`,
    "Then encode the description as Factory files:",
    "- workflows: .factory/workflows/<name>.md, frontmatter `name` and `stages` (triage, plan, build, verify, pr, with needs, agent, gates, approval), the body says when it applies;",
    "- minions: .factory/minions/<name>.yml for recurring jobs with no issue (name, description, on, prompt);",
    "- skills: .claude/skills/<name>/SKILL.md, frontmatter `name` and `description`, for steps the team does a set way.",
    "Write only what the description calls for. Answer with one JSON object:",
    '{"files": {"<path>": "<full file text>"}, "summary": "<one paragraph for the PR>"}',
  ].join("\n");
}

// Why each proposed file would not load, checked as the watcher and the skill loader would.
export function checkTaught(files: Readonly<Record<string, string>>): string[] {
  const problems = outsideAllowedPaths(Object.keys(files), TEACH_ALLOWED).map(
    (f) => `${f}: not a workflow, minion or skill`,
  );
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== "string") problems.push(`${path}: not file text`);
    else if (path.startsWith(".factory/workflows/")) {
      const parsed = parseWorkflowText(text);
      const name = basename(path).replace(/\.(ya?ml|md)$/, "");
      if (!parsed.ok) problems.push(...parsed.problems.map((p) => `${path}: ${p}`));
      else if (parsed.workflow.name !== name) problems.push(`${path}: name is "${parsed.workflow.name}"`);
    } else if (path.startsWith(".factory/minions/")) {
      const parsed = parseMinion(safeYaml(text));
      if (!parsed.ok) problems.push(...parsed.problems.map((p) => `${path}: ${p}`));
    } else if (path.startsWith(".claude/skills/")) {
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
      const meta = fm ? (safeYaml(fm) as { name?: unknown; description?: unknown } | undefined) : undefined;
      if (basename(path) !== "SKILL.md") problems.push(`${path}: a skill is <name>/SKILL.md`);
      else if (meta?.name !== basename(dirname(path)) || typeof meta?.description !== "string")
        problems.push(`${path}: frontmatter needs name: ${basename(dirname(path))} and a description`);
    }
  }
  return problems;
}

function safeYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
}

export async function runTeach(deps: TeachDeps, config: FactoryConfig, how: string): Promise<TeachResult> {
  if (!how.trim()) return { problems: ["say how the team ships"] };
  const brain = Object.hasOwn(readRegistry(deps.cloneDir).servers ?? {}, "brain");
  const minion: Minion = {
    name: "teach",
    description: "Encode how the team ships as workflows, minions and skills",
    on: { event: "factory.issue.ready" },
    prompt: teachPrompt(how, ciFiles(deps.cloneDir), brain),
    mcp: brain ? ["brain"] : [],
    budgetUsd: config.maxBudgetUsd.plan,
    runtime: "local",
    checkout: true,
  };
  const run = await runMinion(deps, config, minion);
  if (run.status !== "ok") return { problems: [run.reason ?? "the teach run did not finish"] };
  const out = run.output as { files?: unknown; summary?: unknown };
  const files = out?.files && typeof out.files === "object" ? (out.files as Record<string, string>) : {};
  if (Object.keys(files).length === 0) return { problems: ["the agent proposed no files"] };
  const problems = checkTaught(files);
  if (problems.length > 0) return { problems };
  const sha = new Bun.CryptoHasher("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 8);
  const pr = await proposeFiles(deps, {
    repo: config.repo,
    base: config.base,
    branch: `factory/teach-${sha}`,
    files,
    allowed: TEACH_ALLOWED,
    title: "factory: teach how we ship",
    body: [
      typeof out.summary === "string" ? out.summary : "Workflows, minions and skills from `factory teach`.",
      "",
      `Asked: ${how.trim()}`,
      "",
      ...Object.keys(files).map((f) => `- \`${f}\``),
      "",
      "Every file loads with the watcher's parser. Review before merging; nothing runs until it is on the base branch.",
    ].join("\n"),
  });
  return { ...pr, files: Object.keys(files) };
}
