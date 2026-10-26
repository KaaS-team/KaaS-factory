// One risk object per task: the agent's triage and plan ratings, raised to a floor the runner
// rates from the files alone, so an agent that calls a migration "low" cannot talk its way to an
// auto-approval or an auto-merge. The board and the merge policy both read this one object.

import type { Risk } from "./artifacts";
import { touchesProtectedPath } from "./boundary";
import { isTrusted } from "./chatops";
import type { PackageSpec } from "./config";
import { latestDataFor, parseDataMarkers } from "./derive";
import type { GhIssue } from "./github";

const ORDER: readonly Risk[] = ["low", "medium", "high"];

export const maxRisk = (...risks: readonly (Risk | undefined)[]): Risk =>
  ORDER[Math.max(0, ...risks.map((r) => (r ? ORDER.indexOf(r) : 0)))]!;

// Paths whose change is high risk whatever the agent says: schema, CI and dependency changes
// reach every user at once and are the hardest to roll back.
const HIGH_RISK = [
  /(^|\/)migrations?\//,
  /\.sql$/,
  /(^|\/)schema\.(prisma|ts|rb)$/,
  /^\.github\/workflows\//,
  /(^|\/)(package\.json|bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(toml|lock)|go\.(mod|sum)|requirements\.txt|uv\.lock|poetry\.lock|Gemfile(\.lock)?)$/,
  /(^|\/)Dockerfile$/,
];

// Wider than this many files is medium at least, however small each edit is.
export const WIDE_FILES = 10;

export interface BlastRadius {
  readonly files: number;
  readonly packages: readonly string[];
  readonly protected: readonly string[];
  readonly owners: readonly string[];
}

export interface RiskObject {
  readonly level: Risk;
  readonly triage: Risk | null;
  readonly plan: Risk | null;
  readonly floor: Risk;
  readonly blastRadius: BlastRadius;
  readonly reasons: readonly string[];
}

const under = (path: string, pkg: string) => path === pkg || path.startsWith(`${pkg.replace(/\/$/, "")}/`);

// The packages a diff touches, as gates.sh selects them: each package with a changed file under its path.
export function touchedPackages(packages: readonly PackageSpec[], paths: readonly string[]): PackageSpec[] {
  return packages.filter((p) => paths.some((f) => under(f, p.path)));
}

// Protected globs of every package, rooted at the repo so touchesProtectedPath can match them.
export function packageProtectedPaths(packages: readonly PackageSpec[]): string[] {
  return packages.flatMap((p) => (p.protectedPaths ?? []).map((g) => `${p.path.replace(/\/$/, "")}/${g}`));
}

// Owners of the packages a diff touches: a change with any owner needs a human merge.
export function ownersFor(packages: readonly PackageSpec[], paths: readonly string[]): string[] {
  return [...new Set(touchedPackages(packages, paths).flatMap((p) => p.owners ?? []))];
}

export interface RateOptions {
  readonly protectedPaths: readonly string[];
  readonly packages?: readonly PackageSpec[];
}

// The deterministic rating: no model, only the paths, so the same diff always gets the same floor.
export function ratedRisk(
  paths: readonly string[],
  o: RateOptions,
): { level: Risk; blastRadius: BlastRadius; reasons: string[] } {
  const packages = o.packages ?? [];
  const protectedHits = touchesProtectedPath(paths, [...o.protectedPaths, ...packageProtectedPaths(packages)]);
  const owners = ownersFor(packages, paths);
  const reasons: string[] = [];
  const risky = paths.filter((p) => HIGH_RISK.some((re) => re.test(p)));
  if (risky.length) reasons.push(`schema, CI or dependency file: ${risky.join(", ")}`);
  if (protectedHits.length) reasons.push(`protected path: ${protectedHits.join(", ")}`);
  if (owners.length) reasons.push(`owned by ${owners.join(", ")}`);
  let level: Risk = reasons.length ? "high" : "low";
  if (level === "low" && paths.length > WIDE_FILES) {
    level = "medium";
    reasons.push(`${paths.length} files, over ${WIDE_FILES}`);
  }
  const blastRadius = {
    files: paths.length,
    packages: touchedPackages(packages, paths).map((p) => p.path),
    protected: protectedHits,
    owners,
  };
  return { level, blastRadius, reasons };
}

const asRisk = (v: unknown): Risk | null => (v === "low" || v === "medium" || v === "high" ? v : null);

export function riskObject(
  triage: { risk?: unknown } | undefined,
  plan: { risk?: unknown; files?: unknown } | undefined,
  o: RateOptions,
): RiskObject {
  const files = Array.isArray(plan?.files) ? plan.files.filter((f): f is string => typeof f === "string") : [];
  const rated = ratedRisk(files, o);
  const t = asRisk(triage?.risk);
  const p = asRisk(plan?.risk);
  // Nothing rated yet reads as high: an unknown change is never shown as safe.
  const level = t === null && p === null ? "high" : maxRisk(p ?? t ?? undefined, rated.level);
  return { level, triage: t, plan: p, floor: rated.level, blastRadius: rated.blastRadius, reasons: rated.reasons };
}

// The plan step's floor: the plan's own rating, raised to the deterministic one when it is lower.
export function floorPlanRisk<P extends { risk: Risk; files: readonly string[] }>(plan: P, o: RateOptions): P {
  const floor = ratedRisk(plan.files ?? [], o).level;
  if (!plan.risk) return plan;
  return maxRisk(plan.risk, floor) === plan.risk ? plan : { ...plan, risk: floor };
}

// From the issue thread's trusted triage and plan markers, so the board needs no worktree.
export function riskOfIssue(issue: Pick<GhIssue, "comments">, o: RateOptions): RiskObject | null {
  const markers = parseDataMarkers(issue.comments.filter(isTrusted));
  const triage = latestDataFor(markers, "triage") as { risk?: unknown } | undefined;
  const plan = latestDataFor(markers, "plan") as { risk?: unknown; files?: unknown } | undefined;
  if (!triage && !plan) return null;
  return riskObject(triage, plan, o);
}

// Risk by issue number, for a list built from the same issues (the inbox, the board).
export function riskIndex(issues: readonly GhIssue[], o: RateOptions): Map<number, RiskObject | null> {
  return new Map(issues.map((i) => [i.number, riskOfIssue(i, o)]));
}
