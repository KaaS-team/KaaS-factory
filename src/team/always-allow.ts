// An approver's always-allow becomes a pull request on the team file. This module plans that change:
// it adds the rule to roles.<role>.tools and refuses anything the org ceiling or the team's approver
// list would not allow. Opening the PR is the caller's job; nothing here touches the network.
import { loadOrg } from "./load";
import { resolveTeam } from "./resolve";
import { type OrgFile, type TeamFile, teamProblems } from "./schema";

export interface AlwaysAllowInput {
  org: OrgFile;
  team: TeamFile;
  approver: string;
  role: string;
  rule: string;
}

export type AlwaysAllowPlan =
  | { ok: true; path: string; content: string; branch: string; title: string; body: string }
  | { ok: false; reason: string };

const refuse = (reason: string): AlwaysAllowPlan => ({ ok: false, reason });
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

export function planAlwaysAllow(input: AlwaysAllowInput): AlwaysAllowPlan {
  const { org, team, approver, role } = input;
  const rule = input.rule.trim();
  if (!(team.approvers ?? []).includes(approver))
    return refuse(`${approver} is not an approver of team ${team.name}, so the rule is not added.`);
  if (rule === "" || rule === "*" || /^\w+\(\*\)$/.test(rule))
    return refuse(`"${rule}" allows everything; always-allow needs a narrow rule.`);
  if (org.locked?.includes(role)) return refuse(`The org locked role ${role}; a team cannot change its tools.`);
  const tools = team.roles?.[role]?.tools ?? [];
  if (tools.includes(rule)) return refuse(`Role ${role} already allows ${rule}.`);

  const next: TeamFile = {
    ...team,
    roles: { ...team.roles, [role]: { ...team.roles?.[role], tools: [...tools, rule] } },
  };
  const problems = teamProblems(next, "team");
  const resolved = resolveTeam({ builtin: {}, org, team: next });
  const all = [...problems, ...resolved.problems];
  if (all.length) return refuse(all.join(" "));

  const path = `.factory/team/teams/${team.name}.yml`;
  return {
    ok: true,
    path,
    content: Bun.YAML.stringify(next, null, 2),
    branch: `factory/always-allow-${slug(team.name)}-${slug(role)}-${slug(rule)}`,
    title: `Always allow ${rule} for ${role} in ${team.name}`,
    body: `${approver} chose always-allow for \`${rule}\` on role \`${role}\`. It adds one entry to roles.${role}.tools in ${path} and passes the org ceiling check.`,
  };
}

// Reads the org file under dir and plans against it; a broken org file is a refusal.
export function planFromDir(
  dir: string,
  team: TeamFile,
  approver: string,
  role: string,
  rule: string,
): AlwaysAllowPlan {
  const org = loadOrg(dir);
  return org.ok ? planAlwaysAllow({ org: org.value, team, approver, role, rule }) : refuse(org.problems.join(" "));
}
