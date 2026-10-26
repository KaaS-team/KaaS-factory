// Back-pressure per team and for the whole org: a team whose factory work already waits on people
// (plans to approve, PRs to review) gets no new pickups until it drains, so one busy team cannot
// bury its reviewers while another team's queue is empty. A `team:<name>` label names the team.
import type { GhIssue } from "./github";

export interface OrgCaps {
  // Most issues one team may have waiting on people; `teams` overrides it per team.
  readonly perTeam?: number;
  readonly teams?: Readonly<Record<string, number>>;
  // Most waiting across every team, labelled or not.
  readonly org?: number;
}

const TEAM = /^team:(.+)$/;
export const teamOf = (issue: Pick<GhIssue, "labels">): string | undefined =>
  issue.labels.map((l) => TEAM.exec(l.name)?.[1]).find((t) => t !== undefined);

// The ready issues the caps let through, oldest first, counting each admitted one as waiting.
export function admitReady(
  ready: readonly GhIssue[],
  waiting: readonly GhIssue[],
  caps: OrgCaps | undefined,
): GhIssue[] {
  if (!caps) return [...ready];
  const load = new Map<string, number>();
  let total = 0;
  const add = (team: string | undefined) => {
    total++;
    if (team) load.set(team, (load.get(team) ?? 0) + 1);
  };
  for (const issue of new Map(waiting.map((i) => [i.number, i])).values()) add(teamOf(issue));
  const admitted: GhIssue[] = [];
  for (const issue of [...ready].sort((a, b) => a.number - b.number)) {
    const team = teamOf(issue);
    const cap = team ? (caps.teams?.[team] ?? caps.perTeam) : undefined;
    if (caps.org !== undefined && total >= caps.org) break;
    if (team && cap !== undefined && (load.get(team) ?? 0) >= cap) continue;
    admitted.push(issue);
    add(team);
  }
  return admitted;
}

export function capsProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["caps: expected an object"];
  const c = raw as Record<string, unknown>;
  const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const problems: string[] = [];
  for (const key of Object.keys(c))
    if (!["perTeam", "teams", "org"].includes(key))
      problems.push(`caps.${key}: unknown key (allowed: perTeam, teams, org)`);
  for (const key of ["perTeam", "org"])
    if (c[key] !== undefined && !count(c[key])) problems.push(`caps.${key}: expected a whole number, 0 or more`);
  if (c.teams !== undefined) {
    if (typeof c.teams !== "object" || c.teams === null) problems.push("caps.teams: expected an object of team to cap");
    else
      for (const [team, v] of Object.entries(c.teams))
        if (!count(v)) problems.push(`caps.teams.${team}: expected a whole number, 0 or more`);
  }
  return problems;
}
