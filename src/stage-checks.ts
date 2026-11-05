// The checks a stage ran, noted as they finish and stamped on the stage's row once it is recorded, so
// `factory learn --export` can say which check caught what (#627). Pending notes are per issue.

import { readQa } from "./qa";
import type { FactoryState, StageRun } from "./state";

export interface CheckResult {
  readonly name: string;
  readonly result: "pass" | "fail";
}
export interface CheckFinding {
  readonly check: string;
  readonly severity: string;
  readonly what: string;
}

const pending = new Map<string, { checks: CheckResult[]; findings: CheckFinding[] }>();
const slot = (repo: string, issue: number) => {
  const key = `${repo}#${issue}`;
  const got = pending.get(key) ?? { checks: [], findings: [] };
  pending.set(key, got);
  return got;
};

export function noteCheck(repo: string, issue: number, name: string, ok: boolean, what?: string): void {
  const s = slot(repo, issue);
  s.checks.push({ name, result: ok ? "pass" : "fail" });
  if (!ok && what) s.findings.push({ check: name, severity: "must", what });
}

export function noteFinding(repo: string, issue: number, f: CheckFinding): void {
  slot(repo, issue).findings.push(f);
}

// Added on first use, so a database from before #627 needs no migration step in state.ts.
export function ensureCheckColumns(state: FactoryState): void {
  state.write((db) => {
    const have = (db.query("PRAGMA table_info(stage_runs)").all() as { name: string }[]).map((c) => c.name);
    if (!have.includes("checks")) db.exec("ALTER TABLE stage_runs ADD COLUMN checks TEXT");
    if (!have.includes("findings")) db.exec("ALTER TABLE stage_runs ADD COLUMN findings TEXT");
  });
}

export function setStageChecks(
  state: FactoryState,
  where: { repo: string; issue: number; stage: StageRun["stage"] },
  checks: readonly CheckResult[],
  findings: readonly CheckFinding[],
): void {
  ensureCheckColumns(state);
  state.write((db) =>
    db
      .query(
        "UPDATE stage_runs SET checks = $c, findings = $f WHERE id = (SELECT MAX(id) FROM stage_runs WHERE repo = $repo AND issue = $issue AND stage = $stage)",
      )
      .run({
        $repo: where.repo,
        $issue: where.issue,
        $stage: where.stage,
        $c: JSON.stringify(checks),
        $f: JSON.stringify(findings),
      }),
  );
}

export function flushChecks(state: FactoryState, repo: string, issue: number, stage: StageRun["stage"]): void {
  const s = pending.get(`${repo}#${issue}`);
  pending.delete(`${repo}#${issue}`);
  if (s?.checks.length) setStageChecks(state, { repo, issue, stage }, s.checks, s.findings);
}

export function noteVerdict(
  repo: string,
  issue: number,
  v: { result: string; findings: readonly (string | { severity: string; what: string })[] },
): void {
  noteCheck(repo, issue, "reviewer", v.result !== "reject");
  for (const f of v.findings)
    noteFinding(repo, issue, {
      check: "reviewer",
      severity: typeof f === "string" ? "unknown" : f.severity,
      what: typeof f === "string" ? f : f.what,
    });
}

export function noteQa(
  repo: string,
  issue: number,
  routes: readonly { path: string; status: number; ok: boolean }[],
): void {
  noteCheck(
    repo,
    issue,
    "qa",
    routes.every((r) => r.ok),
  );
  for (const r of routes.filter((x) => !x.ok))
    noteFinding(repo, issue, { check: "qa", severity: "must", what: `${r.path} returned ${r.status}` });
}

// The columns exist only once something stamped them; an older row reads as no checks.
export const checksOf = (s: StageRun): { checks: CheckResult[]; findings: CheckFinding[] } => {
  const raw = s as StageRun & { checks?: string | null; findings?: string | null };
  return { checks: parseList(raw.checks), findings: parseList(raw.findings) };
};

export const parseList = <T>(text: string | null | undefined): T[] => {
  try {
    const v = text ? JSON.parse(text) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const GATE = (status: string) => ({ ok: status === "GREEN", what: `gates ${status.toLowerCase()}` });

export function noteGate(repo: string, issue: number, status: string): void {
  noteCheck(repo, issue, "gates", GATE(status).ok, GATE(status).what);
}

// A skipped or unavailable proof ran nothing, so it is no check.
export function noteProof(
  repo: string,
  issue: number,
  proof: { status: string },
  survived?: { reject: boolean },
): void {
  if (proof.status !== "skipped" && proof.status !== "unavailable")
    noteCheck(repo, issue, "proof", proof.status === "bites", `proof ${proof.status}`);
  if (survived) noteCheck(repo, issue, "mutations", !survived.reject, "plan mutations survived");
}

export function noteAcceptance(repo: string, issue: number, proven: boolean | undefined): void {
  if (proven !== undefined) noteCheck(repo, issue, "acceptance", proven, "acceptance not proven");
}

// Stamped directly: notes pending for the next verify must not land on the build row.
export function closeBuild(state: FactoryState, repo: string, issue: number, gateStatus: string): void {
  const g = GATE(gateStatus);
  const findings = g.ok ? [] : [{ check: "gates", severity: "must", what: g.what }];
  setStageChecks(state, { repo, issue, stage: "build" }, [{ name: "gates", result: g.ok ? "pass" : "fail" }], findings);
}

export function closeVerify(
  state: FactoryState,
  repo: string,
  issue: number,
  verdict: Parameters<typeof noteVerdict>[2] | undefined,
): void {
  if (verdict) noteVerdict(repo, issue, verdict);
  flushChecks(state, repo, issue, "verify");
}

export function closePr(state: FactoryState, repo: string, issue: number, worktree: string): void {
  const qa = readQa(worktree, issue);
  if (qa) noteQa(repo, issue, qa.routes);
  flushChecks(state, repo, issue, "pr");
}
