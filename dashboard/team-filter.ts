// `?team=<name>` on the dashboard lists: the repos a team's file names. A team that does not exist
// matches no repo, so a typo shows nothing instead of everything.
import { join } from "node:path";
import { loadTeam } from "../src/team/load";

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
