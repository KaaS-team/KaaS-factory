// Picks the team that takes an issue when a repo is listed by more than one team. A label a team
// owns wins over a changed path it owns; an issue nobody owns goes to the one team of the repo
// that has no `owns`.
import type { TeamFile } from "./schema";

export interface IssueFacts {
  labels: readonly string[];
  paths: readonly string[];
}

export interface Routed {
  team: string;
  by: "label" | "path" | "default" | "only";
}

// "dir/**" matches everything under dir; "*" stays inside one path segment; anything else is literal.
function globRe(glob: string): RegExp {
  const body = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function routeTeam(teams: readonly TeamFile[], repo: string, facts: IssueFacts): Routed | undefined {
  const mine = teams.filter((t) => (t.repos ?? []).some((r) => r.toLowerCase() === repo.toLowerCase()));
  if (mine.length === 0) return undefined;
  if (mine.length === 1) return { team: (mine[0] as TeamFile).name, by: "only" };
  const byLabel = mine.find((t) => (t.owns?.labels ?? []).some((l) => facts.labels.includes(l)));
  if (byLabel) return { team: byLabel.name, by: "label" };
  const byPath = mine.find((t) =>
    (t.owns?.paths ?? []).some((g) => {
      const re = globRe(g);
      return facts.paths.some((p) => re.test(p));
    }),
  );
  if (byPath) return { team: byPath.name, by: "path" };
  const rest = mine.filter((t) => !t.owns);
  return rest.length === 1 ? { team: (rest[0] as TeamFile).name, by: "default" } : undefined;
}
