// An approval names what the human approved: the digest of the exact plan and, at the PR stage, the
// head sha. It expires, is refused when either changed, and is claimed once, so a new commit or a
// revised plan voids an old approve.

import { sha256 } from "./import-plan";

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApprovalBinding {
  readonly planDigest?: string;
  readonly headSha?: string;
  readonly expiresAt: string;
}

export interface ApprovalNow {
  readonly plan?: unknown;
  readonly headSha?: string;
  readonly now: Date;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "bodyHash")
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonical(x)]),
    );
  return v;
}

// Key order and the runner's bodyHash stamp do not change the digest; any other field does.
export function planDigest(plan: unknown): string {
  return sha256(JSON.stringify(canonical(plan)) ?? "null");
}

export function bindingFields(
  plan: unknown,
  headSha: string | undefined,
  now: Date,
  ttlMs = APPROVAL_TTL_MS,
): ApprovalBinding {
  return {
    ...(plan === undefined ? {} : { planDigest: planDigest(plan) }),
    ...(headSha ? { headSha } : {}),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

// Why an approve for the request `asked` must be refused now, or undefined when it still holds.
export function refuseApproval(asked: Record<string, unknown>, current: ApprovalNow): string | undefined {
  const expires = typeof asked.expiresAt === "string" ? Date.parse(asked.expiresAt) : Number.NaN;
  if (!Number.isNaN(expires) && current.now.getTime() > expires) return "that approval has expired";
  if (
    typeof asked.planDigest === "string" &&
    current.plan !== undefined &&
    asked.planDigest !== planDigest(current.plan)
  )
    return "the plan changed since this approval was asked";
  if (typeof asked.headSha === "string" && current.headSha !== undefined && asked.headSha !== current.headSha)
    return "a new commit landed since this approval was asked";
  return undefined;
}

// Check and claim in one synchronous step, so two approves of one token cannot both pass.
const claimed = new Set<string>();
export function claimToken(token: string): boolean {
  if (claimed.has(token)) return false;
  claimed.add(token);
  return true;
}
