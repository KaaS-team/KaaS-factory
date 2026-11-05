// A workflow's `outputs:` (what its run may write, and how much) and `on.until:` (when its schedule
// stops). Checked at load, so a bad file fails at boot; src/safe-outputs.ts enforces them. Pure.

export const OUTPUT_KINDS = ["issue", "comment", "pull_request", "label"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export interface OutputDecl {
  // Writes of this kind one run may make.
  readonly max: number;
  // Put in front of the title of every issue or pull request the run files.
  readonly titlePrefix?: string;
  // Issues only: days after which an item nobody touched is closed.
  readonly expiresDays?: number;
  // Pull requests only: a PR that touches a protected path is filed as an issue with the diff instead.
  readonly onProtectedPath?: "issue";
}
export type Outputs = Readonly<Partial<Record<OutputKind, OutputDecl>>>;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const KEYS = ["max", "title_prefix", "expires", "on_protected_path"];

export function parseOutputs(raw: unknown, problems: string[]): Outputs | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw) || Object.keys(raw).length === 0) {
    problems.push(`outputs: a mapping of ${OUTPUT_KINDS.join(", ")} to {max, title_prefix, expires}`);
    return undefined;
  }
  const out: Partial<Record<OutputKind, OutputDecl>> = {};
  for (const [kind, d] of Object.entries(raw)) {
    const where = `outputs.${kind}`;
    if (!OUTPUT_KINDS.includes(kind as OutputKind)) {
      problems.push(`${where}: unknown output (allowed: ${OUTPUT_KINDS.join(", ")})`);
      continue;
    }
    if (!isObj(d)) {
      problems.push(`${where}: a mapping with max`);
      continue;
    }
    for (const k of Object.keys(d))
      if (!KEYS.includes(k)) problems.push(`${where}.${k}: unknown key (allowed: ${KEYS.join(", ")})`);
    const titled = kind === "issue" || kind === "pull_request";
    const whole = (v: unknown, hi: number): v is number =>
      Number.isInteger(v) && (v as number) >= 1 && (v as number) <= hi;
    if (!whole(d.max, 1000)) problems.push(`${where}.max: required, a whole number from 1 to 1000`);
    if (
      d.title_prefix !== undefined &&
      (!titled || typeof d.title_prefix !== "string" || !d.title_prefix.trim() || d.title_prefix.length > 40)
    )
      problems.push(`${where}.title_prefix: only an issue or pull_request has a title; 1 to 40 characters`);
    if (d.expires !== undefined && (kind !== "issue" || !whole(d.expires, 365)))
      problems.push(`${where}.expires: only an issue expires; days, from 1 to 365`);
    if (d.on_protected_path !== undefined && (kind !== "pull_request" || d.on_protected_path !== "issue"))
      problems.push(`${where}.on_protected_path: only a pull_request takes it, and only the value issue`);
    out[kind as OutputKind] = {
      max: whole(d.max, 1000) ? d.max : 0,
      ...(typeof d.title_prefix === "string" ? { titlePrefix: d.title_prefix } : {}),
      ...(whole(d.expires, 365) ? { expiresDays: d.expires } : {}),
      ...(d.on_protected_path === "issue" ? { onProtectedPath: "issue" as const } : {}),
    };
  }
  if (out.pull_request?.onProtectedPath && !out.issue)
    problems.push("outputs.pull_request.on_protected_path: the fallback files an issue, so declare outputs.issue");
  return out;
}

// `on.until`: the last day, YYYY-MM-DD in UTC, a schedule still files its issue.
export function parseUntil(raw: unknown, problems: string[]): string | undefined {
  if (raw === undefined) return undefined;
  const ok =
    typeof raw === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw) &&
    !Number.isNaN(Date.parse(raw)) &&
    new Date(raw).toISOString().startsWith(raw);
  if (!ok) problems.push("on.until: a date like 2026-12-31, the last day the schedule runs");
  return ok ? (raw as string) : undefined;
}

// `allowed_hosts`: hostnames a run's comments and titles may link to, beyond the built-in ones.
export function parseHosts(raw: unknown, problems: string[]): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const ok =
    Array.isArray(raw) && raw.every((h) => typeof h === "string" && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(h));
  if (!ok) problems.push("allowed_hosts: a list of hostnames, like docs.example.com");
  return ok ? [...new Set((raw as string[]).map((h) => h.toLowerCase()))] : undefined;
}
