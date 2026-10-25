// `factory scan --repo r`: production signal becomes a task (plan section 1,
// Monitor row). Runs `osv-scanner` in the target's local clone, which reads
// any lockfile (npm, bun, pnpm, yarn, uv, poetry, go.sum, Gemfile.lock,
// Cargo.lock, ...); without it, a Bun project falls back to `bun audit --json`.
// Files one issue per PACKAGE with open advisories (audit finding #6). Both
// sources use the same `audit:<package>` marker, so switching one for the
// other never refiles an issue that is already open.
// tests/fixtures/osv-splitbill.json is a trimmed osv-scanner 2.6.0 capture.
//
// Two things about the real CLI output that the first version of this file
// got wrong, found by actually running it against splitbill (bun 1.3.14):
//   - `bun audit --json` is `Record<packageName, Advisory[]>`, not an array
//     and not `{ advisories: [...] }`. There is no `module_name`/`ghsa_id`
//     field on each advisory — the package name is the object key, and the
//     GHSA id has to be pulled out of the advisory's `url`.
//   - `bun outdated --json` does not exist: `--json` is silently ignored and
//     the command prints the same ASCII table as plain `bun outdated`. A
//     naive JSON.parse of that table always fails, so this file no longer
//     calls `bun outdated` at all — filing per-package upgrades is a
//     `upgrading-a-dependency` skill concern once a human opens the issue,
//     not something scan can source structured data for today.
//
// Filing per-package (not per-advisory) keeps a repo with one outdated,
// many-advisory package (hono: 48 advisories in splitbill) from producing
// 48 issues — see tests/fixtures/bun-audit-splitbill.json, captured from a
// real run, for the shape this parses.

import { existsSync } from "node:fs";
import type { ScmPort } from "./github";
import type { CommandRunner } from "./github";
import { LABEL } from "./labels";

export interface ScanFinding {
  readonly id: string; // "audit:<package>"
  readonly title: string;
  readonly body: string;
  readonly labelType: "security" | "dependency" | "bug";
}

function marker(id: string): string {
  return `<!-- factory:scan id=${id} -->`;
}

interface AuditAdvisory {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
  readonly severity?: string;
}

type AuditReport = Record<string, AuditAdvisory[]>;

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1 };

function severityRank(severity: string | undefined): number {
  return SEVERITY_RANK[severity ?? ""] ?? 0;
}

// The advisory has no GHSA id field of its own — pull it from the advisory
// URL (…/advisories/GHSA-xxxx-xxxx-xxxx), falling back to the numeric id.
function ghsaId(advisory: AuditAdvisory): string {
  const match = advisory.url?.match(/GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i);
  return match ? match[0] : String(advisory.id ?? "unknown");
}

interface Advisory {
  readonly id: string;
  readonly severity: string; // "critical" | "high" | "moderate" | "low" | "unknown"
  readonly title: string;
}

function packageFinding(pkg: string, advisories: Advisory[], source: string): ScanFinding {
  const id = `audit:${pkg}`;
  const sorted = [...advisories].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const worst = sorted[0]!;
  const count = advisories.length;
  return {
    id,
    title: `${count} advisor${count === 1 ? "y" : "ies"} in ${pkg} (worst: ${worst.severity})`,
    body: [
      marker(id),
      `**Package:** ${pkg}`,
      `**Advisories:** ${count}`,
      "",
      ...sorted.map((a) => `- **${a.id}** (${a.severity}): ${a.title}`),
      "",
      `Filed by \`factory scan\` from ${source}.`,
    ].join("\n"),
    labelType: "security" as const,
  };
}

function parseJson(json: string): unknown {
  try {
    return json.trim() ? JSON.parse(json) : undefined;
  } catch {
    return undefined;
  }
}

export function parseAuditFindings(json: string): ScanFinding[] {
  const parsed = parseJson(json);
  // `bun audit --json` with nothing to report, and any shape this file
  // doesn't recognize, both fall through to "no findings" rather than a
  // crash — scan is best-effort, not a gate.
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) return [];

  const report = parsed as AuditReport;
  const findings: ScanFinding[] = [];
  for (const [pkg, advisoriesRaw] of Object.entries(report)) {
    const advisories = Array.isArray(advisoriesRaw) ? advisoriesRaw : [];
    if (advisories.length === 0) continue;
    const list = advisories.map((a) => ({
      id: ghsaId(a),
      severity: a.severity ?? "unknown",
      title: a.title ?? "untitled advisory",
    }));
    findings.push(packageFinding(pkg, list, "`bun audit --json`"));
  }
  return findings;
}

interface OsvVulnerability {
  readonly id?: string;
  readonly summary?: string;
  readonly database_specific?: { readonly severity?: string };
}
interface OsvReport {
  readonly results?: {
    readonly packages?: {
      readonly package?: { readonly name?: string };
      readonly vulnerabilities?: OsvVulnerability[];
    }[];
  }[];
}

// `osv-scanner scan source -r --format json`: results per lockfile, packages
// per result. A package in two lockfiles is one finding; its advisories merge by id.
export function parseOsvFindings(json: string): ScanFinding[] {
  const parsed = parseJson(json) as OsvReport | undefined;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.results)) return [];
  const byPackage = new Map<string, Map<string, Advisory>>();
  for (const result of parsed.results) {
    for (const entry of result.packages ?? []) {
      const pkg = entry.package?.name;
      if (!pkg) continue;
      const advisories = byPackage.get(pkg) ?? new Map<string, Advisory>();
      for (const v of entry.vulnerabilities ?? []) {
        if (!v.id) continue;
        advisories.set(v.id, {
          id: v.id,
          severity: (v.database_specific?.severity ?? "unknown").toLowerCase(),
          title: v.summary ?? "untitled advisory",
        });
      }
      if (advisories.size) byPackage.set(pkg, advisories);
    }
  }
  return [...byPackage].map(([pkg, advisories]) => packageFinding(pkg, [...advisories.values()], "`osv-scanner`"));
}

export interface ScanDeps {
  readonly github: ScmPort;
  // Runs argv[0] with the rest; a program that is not installed returns code 127.
  readonly runner: CommandRunner;
}

export interface ScanResult {
  readonly filed: string[]; // issue titles filed this run
  readonly skipped: string[]; // findings already open, deduped by marker
  readonly source?: "osv-scanner" | "bun audit" | "lighthouse";
  // Set instead of filing when no scanner could read this repo (plan v2.6.2
  // item 6: a repo scan cannot read must not fail, or silently parse a
  // scanner's error output as zero findings).
  readonly skippedReason?: string;
}

// osv-scanner exits 0 with no vulnerabilities, 1 with some, and 128 when it
// found no lockfile it reads; anything else is an error, never "no findings".
const OSV_OK = new Set([0, 1]);
const OSV_NO_PACKAGES = 128;
export const OSV_ARGV = ["osv-scanner", "scan", "source", "-r", "--format", "json", "."];

async function findingsOf(
  deps: ScanDeps,
  cloneDir: string,
): Promise<{ findings: ScanFinding[]; source: ScanResult["source"] } | { skippedReason: string }> {
  const osv = await deps.runner.run(OSV_ARGV, { cwd: cloneDir });
  if (OSV_OK.has(osv.code)) return { findings: parseOsvFindings(osv.stdout), source: "osv-scanner" };
  if (osv.code === OSV_NO_PACKAGES) return { skippedReason: "osv-scanner found no lockfile it reads here" };
  const bunProject = existsSync(`${cloneDir}/bun.lock`) || existsSync(`${cloneDir}/bun.lockb`);
  if (osv.code !== 127)
    return {
      skippedReason: `osv-scanner failed (exit ${osv.code}): ${osv.stderr.trim().split("\n").slice(-3).join(" ")}`,
    };
  if (!bunProject)
    return {
      skippedReason:
        "osv-scanner is not installed, and with no bun.lock (or bun.lockb) `bun audit` cannot stand in: install osv-scanner",
    };
  const audit = await deps.runner.run(["bun", "audit", "--json"], { cwd: cloneDir });
  return { findings: parseAuditFindings(audit.stdout), source: "bun audit" };
}

export async function scan(deps: ScanDeps, repo: string, cloneDir: string): Promise<ScanResult> {
  const found = await findingsOf(deps, cloneDir);
  if ("skippedReason" in found) return { filed: [], skipped: [], skippedReason: found.skippedReason };
  const { findings, source } = found;

  return { ...(await fileFindings(deps.github, repo, findings)), source };
}

// One issue per finding id, never a second while one is open: the marker in the body is the key.
async function fileFindings(github: ScmPort, repo: string, findings: ScanFinding[]) {
  const open = await github.listOpenIssues(repo);
  const openMarkers = new Set(
    open.flatMap((i) => [...i.body.matchAll(/<!-- factory:scan id=([^\s]+) -->/g)].map((m) => m[1])),
  );

  const filed: string[] = [];
  const skipped: string[] = [];
  for (const finding of findings) {
    if (openMarkers.has(finding.id)) {
      skipped.push(finding.title);
      continue;
    }
    await github.createIssue(repo, finding.title, finding.body, [finding.labelType, LABEL.monitor]);
    filed.push(finding.title);
  }
  return { filed, skipped };
}

// The report a target repo's Lighthouse run writes (LIGHTHOUSE_REPORT=path): every category under its bar.
interface LighthouseMiss {
  readonly path?: string;
  readonly mode?: string; // "mobile" | "desktop"
  readonly category?: string;
  readonly score?: number;
  readonly bar?: number;
  readonly audits?: string[]; // the failing weighted audits, as the run printed them
}

// One finding per PAGE, whatever its modes and categories, so a slow page is one issue and the fix lands once.
export function parseLighthouseFindings(json: string): ScanFinding[] {
  const parsed = parseJson(json) as { misses?: LighthouseMiss[] } | undefined;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.misses)) return [];
  const byPath = new Map<string, LighthouseMiss[]>();
  for (const m of parsed.misses) if (m.path) byPath.set(m.path, [...(byPath.get(m.path) ?? []), m]);
  return [...byPath].map(([path, misses]) => {
    const id = `lighthouse:${path}`;
    const worst = [...misses].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0]!;
    return {
      id,
      title: `Lighthouse below the bar on ${path} (${worst.mode} ${worst.category} ${worst.score}, bar ${worst.bar})`,
      body: [
        marker(id),
        `**Page:** ${path}`,
        "",
        ...misses.flatMap((m) => [
          `- **${m.mode} ${m.category}:** ${m.score}, bar ${m.bar}`,
          ...(m.audits ?? []).map((a) => `  - ${a}`),
        ]),
        "",
        "Filed by `factory scan --lighthouse` from the nightly run.",
      ].join("\n"),
      labelType: "bug" as const,
    };
  });
}

export async function scanLighthouse(github: ScmPort, repo: string, reportJson: string): Promise<ScanResult> {
  const parsed = parseJson(reportJson) as { misses?: unknown } | undefined;
  // A report that is not one is an error, never "every page passed".
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.misses))
    return { filed: [], skipped: [], skippedReason: "the Lighthouse report has no `misses` array" };
  return { ...(await fileFindings(github, repo, parseLighthouseFindings(reportJson))), source: "lighthouse" };
}
