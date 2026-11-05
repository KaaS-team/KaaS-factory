// Who may do what for a team: how far the factory goes alone, an ordered chain of approvers for
// sensitive paths, and the agent-and-person pair every recorded action carries.
import type { PolicySpec } from "./schema";

export const LEVELS = ["suggest", "change-with-approval", "merge-on-green"] as const;
export type Level = (typeof LEVELS)[number];

export interface ApprovalChain {
  readonly paths: readonly string[];
  // In the order they must approve.
  readonly approvers: readonly string[];
}

export interface ApprovalPolicy {
  readonly level: Level;
  readonly chains: readonly ApprovalChain[];
}

export const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level);
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

// A policy with neither a level nor a chain leaves the repo's own settings alone.
export function approvalPolicyOf(p: PolicySpec | undefined): ApprovalPolicy | undefined {
  if (!p?.autonomy_level && !p?.approval_chains?.length) return undefined;
  return { level: p.autonomy_level ?? "merge-on-green", chains: p.approval_chains ?? [] };
}

export const mayBuild = (level: Level): boolean => level !== "suggest";
export const mayMerge = (level: Level): boolean => level === "merge-on-green";

export interface ChainRefusal {
  readonly reason: "approval-chain";
  readonly detail: string;
}

// `approvedBy` lists each approver in the order the host reports their latest approval.
export function chainRefusals(
  chains: readonly ApprovalChain[],
  files: readonly { readonly path: string }[],
  approvedBy: readonly string[] | undefined,
): ChainRefusal[] {
  const out: ChainRefusal[] = [];
  const seen = (approvedBy ?? []).map((a) => a.toLowerCase());
  for (const chain of chains) {
    const globs = chain.paths.map((p) => new Bun.Glob(p));
    const hit = files.filter((f) => globs.some((g) => g.match(f.path)));
    if (hit.length === 0) continue;
    const label = `${chain.paths.join(", ")} (${chain.approvers.join(" then ")})`;
    let after = -1;
    for (const who of chain.approvers) {
      const at = seen.indexOf(who.toLowerCase());
      if (at < 0) {
        out.push({ reason: "approval-chain", detail: `${label} is missing the approval of ${who}` });
        break;
      }
      if (at < after) {
        out.push({ reason: "approval-chain", detail: `${label}: ${who} approved before the one ahead of them` });
        break;
      }
      after = at;
    }
  }
  return out;
}

// The agent that acted and the person it acted for, written into every audit comment.
export interface Actor {
  readonly agent: string;
  readonly person: string;
}

const ACTOR = /<!-- factory:actor agent=(\S+) person=(\S+) -->/;
const token = (s: string): string => s.replace(/[^\w.@-]/g, "_") || "unknown";

export const actorMarker = (a: Actor): string =>
  `<!-- factory:actor agent=${token(a.agent)} person=${token(a.person)} -->`;

export function parseActor(body: string): Actor | undefined {
  const m = ACTOR.exec(body);
  return m ? { agent: m[1] as string, person: m[2] as string } : undefined;
}

export const actorLine = (a: Actor): string => `Acted as agent ${a.agent} for ${a.person}.\n${actorMarker(a)}`;

// The merge acts for the last person who approved the PR; with no approver it says so.
export const actorFor = (approvedBy: readonly string[] | undefined): Actor => ({
  agent: "factory",
  person: approvedBy?.at(-1) || "unattributed",
});
