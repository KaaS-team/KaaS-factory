// The per-issue config. The config the watcher starts with is loaded without an issue, so a repo
// that several teams list gets the repo-level values. Once an issue is in hand its labels, and the
// paths its body names, pick the team (src/team/route.ts) and that team's layers apply to its run.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type FactoryConfig, loadConfigExplained } from "../config";
import type { GhIssue } from "../github";
import { labelsOf } from "./common";

// Repo paths an issue body names in backticks, such as `src/web/app.ts`; a token needs a slash.
export function pathsNamedIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/`([^`\s]+\/[^`\s]*)`/g)) out.add((m[1] as string).replace(/^\.?\//, ""));
  return [...out];
}

export async function configForIssue(cloneDir: string, config: FactoryConfig, issue: GhIssue): Promise<FactoryConfig> {
  if (!existsSync(join(cloneDir, ".factory", "team"))) return config;
  try {
    const applied = await loadConfigExplained(cloneDir, {
      issue: { labels: labelsOf(issue), paths: pathsNamedIn(issue.body ?? "") },
    });
    return applied.config;
  } catch {
    return config;
  }
}
