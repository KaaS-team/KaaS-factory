// Shared CI baseline (#349): audit a list of repos for missing CI or a runner label the org cannot serve,
// and flag jobs queued too long. Pure functions; the CLI reads JSON from disk so a hook can feed it.
import { readFileSync } from "node:fs";

export const DEFAULT_LABELS = ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "self-hosted"];
export const QUEUE_LIMIT_MINUTES = 10;

export type RepoCi = { repo: string; workflows: { path: string; content: string }[] };
export type QueuedJob = { repo: string; job: string; queuedAt: string };

const labelsOf = (content: string): string[] =>
  [...content.matchAll(/^\s*runs-on:\s*(.+)$/gm)].flatMap((m) =>
    m[1]!
      .replace(/#.*$/, "")
      .replace(/[[\]'"]/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

export function auditRepos(repos: RepoCi[], allowed: string[] = DEFAULT_LABELS): string[] {
  const out: string[] = [];
  for (const { repo, workflows } of repos) {
    if (workflows.length === 0) {
      out.push(`${repo}: no CI workflow`);
      continue;
    }
    for (const w of workflows) {
      for (const label of labelsOf(w.content)) {
        // An expression (matrix, vars) cannot be checked statically, so it passes.
        if (!label.includes("${{") && !allowed.includes(label))
          out.push(`${repo}: ${w.path} uses runner label "${label}"`);
      }
    }
  }
  return out;
}

export function stuckJobs(jobs: QueuedJob[], now: Date, limit = QUEUE_LIMIT_MINUTES): string[] {
  const out: string[] = [];
  for (const j of jobs) {
    const minutes = Math.floor((now.getTime() - new Date(j.queuedAt).getTime()) / 60000);
    if (minutes > limit) out.push(`${j.repo}: job "${j.job}" queued ${minutes} minutes`);
  }
  return out;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun scripts/ci-baseline.ts <repos.json>  ({repos: RepoCi[], queued?: QueuedJob[]})");
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(path, "utf8")) as { repos: RepoCi[]; queued?: QueuedJob[] };
  const found = [...auditRepos(data.repos), ...stuckJobs(data.queued ?? [], new Date())];
  for (const line of found) console.error(line);
  process.exit(found.length ? 1 : 0);
}
