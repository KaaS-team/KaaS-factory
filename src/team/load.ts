// Reads <dir>/org.yml and <dir>/teams/*.yml and checks each with teamProblems.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type OrgFile, type TeamFile, teamProblems } from "./schema";

export type Loaded<T> = { ok: true; value: T } | { ok: false; problems: string[] };

function readFile<T>(file: string, kind: "org" | "team", label: string): Loaded<T> {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, problems: [`${label}: the file is not valid YAML (${(e as Error).message}).`] };
  }
  const problems = teamProblems(raw, kind).map((p) => `${label}: ${p}`);
  return problems.length ? { ok: false, problems } : { ok: true, value: raw as T };
}

// No org.yml is valid: the org then sets no policy.
export function loadOrg(dir: string): Loaded<OrgFile> {
  const file = join(dir, "org.yml");
  return existsSync(file) ? readFile<OrgFile>(file, "org", "org.yml") : { ok: true, value: { name: "org" } };
}

export function loadTeams(dir: string): Loaded<TeamFile[]> {
  const teams = join(dir, "teams");
  const files = existsSync(teams)
    ? readdirSync(teams)
        .filter((f) => f.endsWith(".yml"))
        .sort()
    : [];
  const value: TeamFile[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const label = `teams/${f}`;
    const r = readFile<TeamFile>(join(teams, f), "team", label);
    if (!r.ok) problems.push(...r.problems);
    else if (r.value.name !== f.slice(0, -".yml".length))
      problems.push(`${label}: name is "${r.value.name}" but the file is named ${f.slice(0, -".yml".length)}.`);
    else value.push(r.value);
  }
  return problems.length ? { ok: false, problems } : { ok: true, value };
}

export function loadTeam(dir: string, name: string): Loaded<TeamFile> {
  const all = loadTeams(dir);
  if (!all.ok) return all;
  const found = all.value.find((t) => t.name === name);
  return found
    ? { ok: true, value: found }
    : { ok: false, problems: [`There is no team named ${name} in ${dir}/teams.`] };
}
