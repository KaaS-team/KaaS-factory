// `factory audit`: where a repo stands before the work starts. Three lenses (repo, process, PR history),
// each a list of yes/no checks scored 0-100, and one report with three layers: findings, fixes, plan.
// Pure over its input, so a fixture produces the same report every time.

export interface AuditChange {
  readonly pr: string;
  readonly subject: string;
  readonly files: readonly string[];
}

export interface AuditInput {
  readonly files: readonly string[];
  readonly read: (path: string) => string | undefined;
  readonly changes: readonly AuditChange[];
}

export type Lens = "repo" | "process" | "prs";
export type Severity = "high" | "medium" | "low";
export const LENSES: readonly Lens[] = ["repo", "process", "prs"];

export interface Finding {
  readonly id: string;
  readonly lens: Lens;
  readonly severity: Severity;
  readonly title: string;
  readonly evidence: string;
  readonly fix: string;
}

export interface LensScore {
  readonly lens: Lens;
  readonly score: number;
  readonly passed: number;
  readonly total: number;
}

export interface PlanPhase {
  readonly name: string;
  readonly findings: readonly string[];
}

export interface AuditReport {
  readonly scores: readonly LensScore[];
  readonly findings: readonly Finding[];
  readonly plan: readonly PlanPhase[];
}

// A check passes, or becomes a finding.
type Check = (i: AuditInput) => Omit<Finding, "id" | "lens"> | undefined;
const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { high: 0, medium: 1, low: 2 };

const has = (i: AuditInput, re: RegExp) => i.files.some((f) => re.test(f));
const isTest = (f: string) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/.test(f);
const isDoc = (f: string) => /\.(md|txt)$/.test(f) || f.startsWith("docs/");
const miss = (severity: Severity, title: string, evidence: string, fix: string) => ({
  severity,
  title,
  evidence,
  fix,
});
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100));

const REPO_CHECKS: Readonly<Record<string, Check>> = {
  "repo-tests": (i) =>
    !i.files.some(isTest)
      ? miss(
          "high",
          "No tests found",
          "no file under tests/, __tests__ or named *.test.*",
          "Add a first test that runs the main path, then run it in CI.",
        )
      : undefined,
  "repo-ci": (i) =>
    has(i, /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\//)
      ? undefined
      : miss(
          "high",
          "No CI configuration",
          "no workflow under .github/workflows, no .gitlab-ci.yml or .circleci",
          "Add a CI job that runs the tests on every pull request.",
        ),
  "repo-lockfile": (i) =>
    has(
      i,
      /^(bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|go\.sum|Gemfile\.lock)$/,
    )
      ? undefined
      : miss(
          "medium",
          "No lockfile",
          "no lockfile at the repo root",
          "Commit the lockfile so installs match across machines.",
        ),
  "repo-readme": (i) =>
    has(i, /^README(\.[a-z]+)?$/i)
      ? undefined
      : miss(
          "medium",
          "No README",
          "no README at the repo root",
          "Write a README with what the project is, how to run it and how to test it.",
        ),
  "repo-license": (i) =>
    has(i, /^(LICENSE|COPYING)(\.[a-z]+)?$/i)
      ? undefined
      : miss(
          "low",
          "No license file",
          "no LICENSE at the repo root",
          "Add the license the owners intend, or state that the code is private.",
        ),
  "repo-ignore": (i) =>
    has(i, /^\.gitignore$/)
      ? undefined
      : miss(
          "low",
          "No .gitignore",
          "no .gitignore at the repo root",
          "Ignore build output, dependencies and local env files.",
        ),
  "repo-env": (i) =>
    i.files.includes(".env")
      ? miss(
          "high",
          "A .env file is committed",
          ".env is tracked in the repo",
          "Remove it from history, rotate what it held, and commit a .env.example instead.",
        )
      : undefined,
};

const PROCESS_CHECKS: Readonly<Record<string, Check>> = {
  "process-pr-template": (i) =>
    has(i, /^(\.github\/)?(docs\/)?pull_request_template\.md$|^\.github\/PULL_REQUEST_TEMPLATE(\/|\.md)/i)
      ? undefined
      : miss(
          "medium",
          "No pull request template",
          "no pull_request_template.md",
          "Add a template that asks what changed, why, and how it was tested.",
        ),
  "process-issue-templates": (i) =>
    has(i, /^\.github\/ISSUE_TEMPLATE\//)
      ? undefined
      : miss(
          "low",
          "No issue templates",
          "no .github/ISSUE_TEMPLATE",
          "Add a bug and a task template so issues arrive with the facts a build needs.",
        ),
  "process-owners": (i) =>
    has(i, /^(\.github\/|docs\/)?CODEOWNERS$/)
      ? undefined
      : miss(
          "medium",
          "No CODEOWNERS",
          "no CODEOWNERS file",
          "Name an owner for each area so reviews have a default reader.",
        ),
  "process-contributing": (i) =>
    has(i, /^(\.github\/)?CONTRIBUTING(\.[a-z]+)?$/i)
      ? undefined
      : miss(
          "low",
          "No contributing guide",
          "no CONTRIBUTING file",
          "Write down how to branch, test and ask for review.",
        ),
  "process-security": (i) =>
    has(i, /^(\.github\/)?SECURITY(\.[a-z]+)?$/i)
      ? undefined
      : miss("low", "No security policy", "no SECURITY file", "Say where to report a vulnerability."),
  "process-agent-rules": (i) =>
    has(i, /^(AGENTS|CLAUDE)\.md$/)
      ? undefined
      : miss(
          "low",
          "No agent instructions",
          "no AGENTS.md or CLAUDE.md",
          "Record the commands and rules a coding agent must follow.",
        ),
};

const prsWith = (i: AuditInput, pred: (c: AuditChange) => boolean) => i.changes.filter(pred).length;

const PR_CHECKS: Readonly<Record<string, Check>> = {
  "prs-history": (i) =>
    i.changes.length === 0
      ? miss(
          "medium",
          "No pull request history",
          "no first-parent commit ends in (#N)",
          "Merge through pull requests so changes carry review and a number.",
        )
      : undefined,
  "prs-size": (i) => {
    const big = prsWith(i, (c) => c.files.length > 25);
    return i.changes.length > 0 && pct(big, i.changes.length) > 20
      ? miss(
          "medium",
          "Many large pull requests",
          `${big} of ${i.changes.length} PRs changed more than 25 files`,
          "Split work into pull requests of a few files each.",
        )
      : undefined;
  },
  "prs-tests": (i) => {
    const code = i.changes.filter((c) => c.files.some((f) => !isTest(f) && !isDoc(f)));
    const bare = code.filter((c) => !c.files.some(isTest)).length;
    return code.length > 0 && pct(bare, code.length) > 50
      ? miss(
          "high",
          "Most code changes ship without a test",
          `${bare} of ${code.length} code PRs touched no test`,
          "Require a test change in every code PR and check it in CI.",
        )
      : undefined;
  },
  "prs-reverts": (i) => {
    const reverts = prsWith(i, (c) => /^revert\b/i.test(c.subject));
    return i.changes.length > 0 && pct(reverts, i.changes.length) > 10
      ? miss(
          "medium",
          "Frequent reverts",
          `${reverts} of ${i.changes.length} PRs are reverts`,
          "Find what lets breaking changes merge, and gate on it before merge.",
        )
      : undefined;
  },
};

const LENS_CHECKS: Readonly<Record<Lens, Readonly<Record<string, Check>>>> = {
  repo: REPO_CHECKS,
  process: PROCESS_CHECKS,
  prs: PR_CHECKS,
};

export function audit(input: AuditInput): AuditReport {
  const scores: LensScore[] = [];
  const findings: Finding[] = [];
  for (const lens of LENSES) {
    const checks = Object.entries(LENS_CHECKS[lens]);
    const found = checks.flatMap(([id, check]) => {
      const f = check(input);
      return f ? [{ id, lens, ...f }] : [];
    });
    findings.push(...found);
    scores.push({
      lens,
      score: pct(checks.length - found.length, checks.length),
      passed: checks.length - found.length,
      total: checks.length,
    });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id));
  return { scores, findings, plan: planOf(findings) };
}

const PHASES: ReadonlyArray<readonly [string, Severity]> = [
  ["Week 1: stop the risks", "high"],
  ["Weeks 2 to 3: close the process gaps", "medium"],
  ["Later: tidy", "low"],
];

function planOf(findings: readonly Finding[]): PlanPhase[] {
  return PHASES.map(([name, severity]) => ({
    name,
    findings: findings.filter((f) => f.severity === severity).map((f) => f.id),
  })).filter((p) => p.findings.length > 0);
}

export function renderReport(report: AuditReport): string {
  const out = ["# Repo audit", "", "## Scores", ""];
  for (const s of report.scores) out.push(`- ${s.lens}: ${s.score}/100 (${s.passed} of ${s.total} checks pass)`);
  out.push("", "## Findings", "");
  if (report.findings.length === 0) out.push("None.");
  for (const f of report.findings) out.push(`- [${f.severity}] ${f.id}: ${f.title}. ${f.evidence}.`);
  out.push("", "## Fixes", "");
  if (report.findings.length === 0) out.push("None.");
  for (const f of report.findings) out.push(`- ${f.id}: ${f.fix}`);
  out.push("", "## Plan", "");
  if (report.plan.length === 0) out.push("Nothing to do.");
  report.plan.forEach((p, n) => out.push(`${n + 1}. ${p.name}: ${p.findings.join(", ")}`));
  return `${out.join("\n")}\n`;
}

export function findingMarker(id: string): string {
  return `<!-- factory:audit id=${id} -->`;
}

export function issueFor(f: Finding): { title: string; body: string } {
  return {
    title: `Audit: ${f.title}`,
    body: `${f.evidence}.\n\n**Fix:** ${f.fix}\n\nLens: ${f.lens}. Severity: ${f.severity}.\n\n${findingMarker(f.id)}`,
  };
}
