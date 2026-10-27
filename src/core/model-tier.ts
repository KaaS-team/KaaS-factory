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

// Each verify reject climbs one rung (small, the agent's `model`, large), so a cheap model that
// failed is not asked again for the same answer. Without a scope the climb starts at `model`.
const LADDER: readonly (Tier | undefined)[] = ["small", undefined, "large"];

export function tierFor(scope: IssueScope | undefined, rejects = 0): Tier | undefined {
  const base = !scope
    ? 1
    : scope.risk === "high" || scope.files >= LARGE_MIN_FILES
      ? 2
      : scope.risk === "low" && scope.files <= SMALL_MAX_FILES
        ? 0
        : 1;
  return LADDER[Math.min(LADDER.length - 1, base + rejects)];
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

export type Family = "haiku" | "sonnet" | "opus";
const FAMILIES: readonly Family[] = ["haiku", "sonnet", "opus"];

// A dated snapshot (-YYYYMMDD) is not matched: it is the same model as its family row.
export function latestModel(family: string, ids: readonly string[]): string | undefined {
  const re = new RegExp(`^claude-${family}-(\\d{1,2}(?:-\\d{1,2})*)$`);
  let best: { id: string; version: number[] } | undefined;
  for (const id of ids) {
    const m = re.exec(id);
    if (!m) continue;
    const version = m[1]!.split("-").map(Number);
    if (!best || newer(version, best.version)) best = { id, version };
  }
  return best?.id;
}

// Numeric per part, so 5-5 beats 5 and 5 beats 4-5; a string compare would put 4-5 first.
function newer(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

const familyOf = (v: unknown): Family | undefined => FAMILIES.find((f) => f === v);

export function buildFamily(plan: unknown): Family {
  const p = plan as { model?: unknown; tasks?: unknown } | undefined;
  const own = familyOf(p?.model);
  if (own) return own;
  const tasks = Array.isArray(p?.tasks) ? (p.tasks as { model?: unknown }[]) : [];
  const ranks = tasks.map((t) => FAMILIES.indexOf(familyOf(t?.model) as Family)).filter((i) => i >= 0);
  return FAMILIES[Math.max(0, ...ranks)]!;
}

// One climb to sonnet after a red gate, never to opus: a model that failed twice is a plan problem.
export function buildEscalation(attempt: number): Family | undefined {
  return attempt === 0 ? "sonnet" : undefined;
}
