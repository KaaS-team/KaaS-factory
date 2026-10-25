// The cheapest model that is enough: a small, low-risk change runs on an agent's `models.small`, a
// risky or wide one on `models.large`, and the rest on its `model`. Risk and file count come from
// the plan, else the triage; triage itself runs before either is known, so it never picks a tier.

export type Tier = "small" | "large";
export interface IssueScope {
  readonly risk: "low" | "medium" | "high";
  readonly files: number;
}

export const SMALL_MAX_FILES = 3;
export const LARGE_MIN_FILES = 11;

export function tierFor(scope: IssueScope | undefined): Tier | undefined {
  if (!scope) return undefined;
  if (scope.risk === "high" || scope.files >= LARGE_MIN_FILES) return "large";
  if (scope.risk === "low" && scope.files <= SMALL_MAX_FILES) return "small";
  return undefined;
}

// The plan's risk and files win over the triage's guess, since the plan has read the code.
export function scopeFrom(plan: unknown, triage: unknown): IssueScope | undefined {
  const read = (v: unknown, key: "files" | "files_expected"): IssueScope | undefined => {
    const o = v as { risk?: unknown; [k: string]: unknown } | undefined;
    const files = o?.[key];
    if (!o || (o.risk !== "low" && o.risk !== "medium" && o.risk !== "high") || !Array.isArray(files)) return undefined;
    return { risk: o.risk, files: files.length };
  };
  return read(plan, "files") ?? read(triage, "files_expected");
}
