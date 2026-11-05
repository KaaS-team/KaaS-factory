// `?team=<name>` on the dashboard lists: the repos a team's file names. A team that does not exist
// matches no repo, so a typo shows nothing instead of everything.
import { join } from "node:path";
import type { GhIssue } from "../src/github";
import { loadTeam, loadTeams } from "../src/team/load";
import { routeTeam } from "../src/team/route";

export function teamRepos(cloneDir: string | undefined, team: string): string[] {
  if (!cloneDir || !/^[\w.-]+$/.test(team)) return [];
  const loaded = loadTeam(join(cloneDir, ".factory", "team"), team);
  return loaded.ok ? (loaded.value.repos ?? []) : [];
}

export function narrowToTeam(repos: readonly string[], team: string | null, cloneDir: string | undefined): string[] {
  if (team === null) return [...repos];
  const mine = teamRepos(cloneDir, team).map((r) => r.toLowerCase());
  return repos.filter((r) => mine.includes(r.toLowerCase()));
}

export function teamNames(cloneDir: string | undefined): string[] {
  if (!cloneDir) return [];
  const all = loadTeams(join(cloneDir, ".factory", "team"));
  return all.ok ? all.value.map((t) => t.name) : [];
}

// Whether one issue belongs to `team`. A repo only one team lists belongs to that team whole; a repo
// several teams list is split by the issue's labels through the runner's own routing, and an issue
// whose labels are unknown (it is closed, so no open list has it) is left out rather than guessed.
export function issueInTeam(
  cloneDir: string | undefined,
  team: string,
  repo: string,
  labels: readonly string[] | undefined,
): boolean {
  if (!cloneDir) return false;
  const all = loadTeams(join(cloneDir, ".factory", "team"));
  if (!all.ok) return false;
  const lower = repo.toLowerCase();
  const listing = all.value.filter((t) => (t.repos ?? []).some((r) => r.toLowerCase() === lower));
  if (!listing.some((t) => t.name === team)) return false;
  if (listing.length === 1) return true;
  if (!labels) return false;
  return routeTeam(listing, repo, { labels, paths: [] })?.team === team;
}

// Keeps the rows of the issues `team` owns. Labels come from each repo's open issues, read once per call.
export function teamFilter(cloneDir: string | undefined, openIssues: (repo: string) => Promise<readonly GhIssue[]>) {
  return async (team: string | null, repos: readonly string[]) => {
    if (team === null) return <T>(rows: T[]) => rows;
    const labels = new Map<string, Map<number, string[]>>();
    for (const r of repos)
      labels.set(r, new Map((await openIssues(r)).map((i) => [i.number, i.labels.map((l) => l.name)])));
    return <T extends { repo: string; issue: number }>(rows: T[]) =>
      rows.filter((row) => issueInTeam(cloneDir, team, row.repo, labels.get(row.repo)?.get(row.issue)));
  };
}
