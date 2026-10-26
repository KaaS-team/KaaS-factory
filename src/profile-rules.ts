// What `scaleup` and `enterprise` add beyond PROFILES' defaults: a code owner approves every file
// a factory PR touches before the factory merges it, per-team and org caps on work in flight
// (src/org-caps.ts), and, for enterprise, gates and checks that never run on the host.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig, Profile } from "./config";
import type { ChangedFile, MergeRefusal } from "./merge-policy";
import { capsProblems, type OrgCaps } from "./org-caps";

export interface ProfileRules {
  readonly codeownerApproval: boolean;
  readonly forcedSandbox: boolean;
  readonly caps?: OrgCaps;
}

const OPEN: ProfileRules = { codeownerApproval: false, forcedSandbox: false };
export const PROFILE_RULES: Readonly<Record<Profile, ProfileRules>> = {
  solo: OPEN,
  team: OPEN,
  startup: OPEN,
  scaleup: { codeownerApproval: true, forcedSandbox: false, caps: { perTeam: 3, org: 10 } },
  enterprise: { codeownerApproval: true, forcedSandbox: true, caps: { perTeam: 2, org: 10 } },
};

export const rulesFor = (profile: Profile | undefined): ProfileRules => (profile && PROFILE_RULES[profile]) || OPEN;

// The one resolver: the repo's own `caps`, else its profile's.
export const capsFor = (config: Pick<FactoryConfig, "caps" | "profile">): OrgCaps | undefined =>
  config.caps ?? rulesFor(config.profile).caps;

export interface CodeownersRule {
  readonly pattern: RegExp;
  readonly owners: readonly string[];
}

// GitHub's CODEOWNERS syntax: gitignore-style paths, the last matching line wins, and a line with
// no owners leaves its paths unowned.
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [path, ...owners] = line.split(/\s+/);
    rules.push({ pattern: globToRegex(path!), owners });
  }
  return rules;
}

function globToRegex(glob: string): RegExp {
  const dirOnly = glob.endsWith("/");
  let p = dirOnly ? glob.slice(0, -1) : glob;
  // A leading or inner slash anchors the pattern at the root; a bare name matches at any depth.
  const anchored = p.startsWith("/") || p.includes("/");
  p = p.replace(/^\//, "");
  const body = p
    .split(/(\*\*\/|\/\*\*|\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**/") return "(?:.*/)?";
      if (part === "/**") return "(?:/.*)?";
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  // A literal last segment also owns what sits under it; `docs/*` owns docs' direct children only.
  const literal = !/[*?]/.test(p.slice(p.lastIndexOf("/") + 1));
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${body}${dirOnly ? "/.*" : literal ? "(?:/.*)?" : ""}$`);
}

export function ownersOf(rules: readonly CodeownersRule[], path: string): readonly string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.pattern.test(path)) return rules[i]!.owners;
  return [];
}

// One refusal naming every owned file no owner approved. A team or email owner cannot be
// checked from a review list, so its files wait for a human merge rather than pass unchecked.
export function codeownerRefusals(
  rules: readonly CodeownersRule[],
  files: readonly ChangedFile[],
  approvedBy: readonly string[],
): MergeRefusal[] {
  const approved = new Set(approvedBy.map((l) => `@${l.toLowerCase()}`));
  const waiting = files.flatMap((f) => {
    const owners = ownersOf(rules, f.path);
    return owners.length === 0 || owners.some((o) => approved.has(o.toLowerCase()))
      ? []
      : [`${f.path} (${owners.join(" ")})`];
  });
  if (waiting.length === 0) return [];
  const shown = waiting.slice(0, 5).join(", ") + (waiting.length > 5 ? `, and ${waiting.length - 5} more` : "");
  return [{ reason: "codeowner-approval", detail: `no code owner approved ${shown}` }];
}

// Read from the base clone, never the PR's worktree, so a PR cannot rewrite its own owners.
export function codeownersAt(dir: string): CodeownersRule[] {
  for (const at of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const file = join(dir, at);
    if (existsSync(file)) return parseCodeowners(readFileSync(file, "utf8"));
  }
  return [];
}

// What decideMerge needs to hold a merge for code owners, or undefined when the profile does not ask.
export function codeownerCheck(
  profile: Profile | undefined,
  baseDir: string,
  approvedBy: readonly string[] | undefined,
) {
  if (!rulesFor(profile).codeownerApproval) return undefined;
  return { rules: codeownersAt(baseDir), approvedBy: approvedBy ?? [] };
}

// Config problems these rules add; configProblems runs it on the raw config.
export function profileProblems(cfg: Record<string, unknown>): string[] {
  const problems = capsProblems(cfg.caps);
  if (!rulesFor(cfg.profile as Profile).forcedSandbox) return problems;
  const runtime = (cfg.runtime ?? {}) as Record<string, unknown>;
  for (const key of ["gates", "check"]) {
    const at = runtime[key];
    if (at === undefined || at === "local")
      problems.push(
        `runtime.${key}: the ${cfg.profile} profile runs gates and checks in a sandbox; name a runtime other than "local"`,
      );
  }
  return problems;
}
