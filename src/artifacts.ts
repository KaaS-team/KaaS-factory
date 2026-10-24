// Ported from owainlewis/machinist@3943516 internal/protocol/workflow.go:11-37 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the step envelope (outcome, summary) is optional on our stage artifacts and an absent outcome means complete; every stage rejects unknown fields against its own key list; the runner reads the file, so the 16 KiB and one-object rules live in readJson.
// The contract between a stage skill (running inside `claude`, sandboxed by
// guard-paths.sh + settings.json) and the runner. Section 9 of the plan says
// "the agent cannot push, merge or call gh; only the runner talks to GitHub" —
// enforced here: skills write their comment bodies and structured verdicts to
// `.factory/runs/issue-<N>/*`, which the guard hook always allows, and the
// runner is the only thing that turns those files into GitHub API calls.

import { mkdir, unlink } from "node:fs/promises";
import { schemaProblem } from "./schemas";

export type Disposition = "proceed" | "needs-info" | "refused" | "duplicate";
export type Risk = "low" | "medium" | "high";
export type VerdictResult = "pass" | "reject" | "uncertain";
export type BuildStatus = "green" | "red" | "needs-info";

// How a step ended, from machinist's StepResult. Absent means complete.
export type StepOutcome = "complete" | "blocked" | "failed";
const STEP_OUTCOMES: readonly string[] = ["complete", "blocked", "failed"];

export interface TriageArtifact {
  readonly outcome?: StepOutcome;
  readonly summary?: string;
  readonly disposition: Disposition;
  // One of TYPE_LABELS, or a type this repo added via config.routes (e.g.
  // "content"); validated against the repo's actual type list in schemas.ts.
  readonly type: string;
  readonly risk: Risk;
  readonly done_when: string;
  readonly files_expected: string[];
  readonly gate_level: string;
  readonly confidence: number;
}

export interface PlanArtifact {
  readonly outcome?: StepOutcome;
  readonly summary?: string;
  readonly status?: "needs-info";
  readonly risk: Risk;
  readonly revision: number;
  readonly files: string[];
  readonly autoApproveEligible: boolean;
  readonly commentId?: number;
  // "test" (build writes a failing test first) or "check" (build runs named
  // commands instead). Absent means "test" (plan v2.7.0 item 8).
  readonly proof?: "test" | "check";
}

export interface BuildArtifact {
  readonly outcome?: StepOutcome;
  readonly summary?: string;
  readonly status: BuildStatus;
  readonly gate_line: string;
  readonly rounds: number;
}

// A finding is a plain string (older verdicts) or the blueprint review shape:
// severity, a 0-5 confidence, and what/why/where/fix. Strings never block a pass.
export type Severity = "must" | "should" | "could";
export interface Finding {
  readonly severity: Severity;
  readonly confidence: number;
  readonly what: string;
  readonly where?: string;
  readonly why?: string;
  readonly fix?: string;
}
export interface Criterion {
  readonly id: string;
  readonly status: "pass" | "fail" | "unverified";
  readonly gap?: string;
}

export interface VerdictArtifact {
  readonly outcome?: StepOutcome;
  readonly summary?: string;
  readonly result: VerdictResult;
  readonly rounds: number;
  readonly findings: (string | Finding)[];
  readonly criteria?: Criterion[];
}

// v2.10.0 item 3: read-only, runs after a final outcome. At most one proposal
// (neo's rule of at most one task per review); all three fields absent means
// "nothing worth changing".
export interface RetroArtifact {
  readonly outcome?: StepOutcome;
  readonly summary?: string;
  readonly lesson?: string;
  readonly skill_name?: string;
  readonly skill_edit?: string;
}

// A step result is one JSON object of at most 16 KiB (machinist workflow.go).
export const MAX_STEP_JSON_BYTES = 16 * 1024;
export const VERDICT_KEY_LIST = ["result", "rounds", "findings", "criteria", "outcome", "summary"] as const;
const VERDICT_KEYS = new Set<string>(VERDICT_KEY_LIST);
const FINDING_KEYS = new Set(["severity", "confidence", "what", "where", "why", "fix"]);
const CRITERION_KEYS = new Set(["id", "status", "gap"]);
// A finding this sure and this serious contradicts a pass.
export const BLOCKING_CONFIDENCE = 3;

function unknownKey(obj: object, allowed: Set<string>): string | undefined {
  return Object.keys(obj).find((k) => !allowed.has(k));
}

function stepEnvelopeProblem(o: Record<string, unknown>): string | undefined {
  if (o.outcome !== undefined && !STEP_OUTCOMES.includes(o.outcome as string))
    return "step outcome must be complete, blocked, or failed";
  if (o.summary !== undefined && (typeof o.summary !== "string" || !o.summary.trim()))
    return "step summary must be a non-empty string";
  return undefined;
}

// Every stage artifact rejects a field it does not define, so a typo cannot
// pass as a silent no-op. The verdict has its own, deeper validator above.
export const STEP_KEYS: Record<Exclude<ArtifactStage, "verify">, readonly string[]> = {
  triage: [
    "disposition",
    "type",
    "risk",
    "done_when",
    "files_expected",
    "gate_level",
    "confidence",
    "outcome",
    "summary",
  ],
  plan: ["status", "risk", "revision", "files", "autoApproveEligible", "commentId", "proof", "outcome", "summary"],
  build: ["status", "gate_line", "rounds", "screenshots", "outcome", "summary"],
  pr: ["outcome", "summary"],
  retro: ["lesson", "skill_name", "skill_edit", "outcome", "summary"],
};

// `types` bounds triage's `type` enum to the repo's actual type list
// (typesFor(config.routes)); omit it to fall back to the fixed TYPE_LABELS.
export function validateStepJson(
  stage: Exclude<ArtifactStage, "verify">,
  raw: unknown,
  types?: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const name = JSON_FILENAMES[stage];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, reason: `${name} is not a JSON object` };
  const o = raw as Record<string, unknown>;
  const extra = unknownKey(o, new Set(STEP_KEYS[stage]));
  if (extra) return { ok: false, reason: `${name} has unknown field "${extra}"` };
  const problem = stepEnvelopeProblem(o) ?? schemaProblem(stage, o, types);
  return problem ? { ok: false, reason: `${name}: ${problem}` } : { ok: true };
}

// Where a step that reported "blocked" or "failed" stops. Undefined means carry on.
export function stepStop(
  json: { outcome?: StepOutcome; summary?: string } | undefined,
): { status: "needs-human" | "failed"; reason: string } | undefined {
  if (json?.outcome === "blocked")
    return { status: "needs-human", reason: json.summary ?? "the agent reported it was blocked" };
  if (json?.outcome === "failed") return { status: "failed", reason: json.summary ?? "the agent reported failure" };
  return undefined;
}

// Rejects a verdict that is malformed or contradicts itself. The runner never
// trusts a "pass" that lists a blocking finding or an unverified criterion.
export function validateVerdict(raw: unknown): { ok: true; verdict: VerdictArtifact } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("verdict.json is not a JSON object");
  const v = raw as Record<string, unknown>;
  const extra = unknownKey(v, VERDICT_KEYS);
  if (extra) return bad(`verdict.json has unknown field "${extra}"`);
  const envelope = stepEnvelopeProblem(v);
  if (envelope) return bad(envelope);
  // A blocked or failed verify owes no verdict; the runner routes it by outcome.
  if (v.outcome === "blocked" || v.outcome === "failed") return { ok: true, verdict: v as unknown as VerdictArtifact };
  if (v.result !== "pass" && v.result !== "reject" && v.result !== "uncertain")
    return bad('verdict.json "result" must be pass, reject or uncertain');
  if (!Number.isInteger(v.rounds) || (v.rounds as number) < 0)
    return bad('verdict.json "rounds" must be a non-negative integer');
  if (!Array.isArray(v.findings)) return bad('verdict.json "findings" must be an array');
  for (const f of v.findings) {
    if (typeof f === "string") continue;
    if (typeof f !== "object" || f === null) return bad("a finding must be a string or an object");
    const key = unknownKey(f, FINDING_KEYS);
    if (key) return bad(`a finding has unknown field "${key}"`);
    const o = f as Record<string, unknown>;
    if (o.severity !== "must" && o.severity !== "should" && o.severity !== "could")
      return bad("a finding's severity must be must, should or could");
    if (!Number.isInteger(o.confidence) || (o.confidence as number) < 0 || (o.confidence as number) > 5)
      return bad("a finding's confidence must be an integer from 0 to 5");
    if (typeof o.what !== "string" || !o.what.trim()) return bad('a finding needs a non-empty "what"');
  }
  if (v.criteria !== undefined) {
    if (!Array.isArray(v.criteria)) return bad('verdict.json "criteria" must be an array');
    for (const c of v.criteria) {
      if (typeof c !== "object" || c === null) return bad("a criterion must be an object");
      const key = unknownKey(c, CRITERION_KEYS);
      if (key) return bad(`a criterion has unknown field "${key}"`);
      const o = c as Record<string, unknown>;
      if (typeof o.id !== "string" || !/^AC-\d+$/.test(o.id)) return bad("a criterion id must look like AC-1");
      if (o.status !== "pass" && o.status !== "fail" && o.status !== "unverified")
        return bad("a criterion status must be pass, fail or unverified");
    }
  }
  const verdict = v as unknown as VerdictArtifact;
  if (verdict.result === "pass") {
    const blocking = verdict.findings.find(
      (f) => typeof f !== "string" && f.severity !== "could" && f.confidence >= BLOCKING_CONFIDENCE,
    );
    if (blocking) return bad(`verdict is pass but lists a blocking finding: ${(blocking as Finding).what}`);
    const open = verdict.criteria?.find((c) => c.status !== "pass");
    if (open) return bad(`verdict is pass but ${open.id} is ${open.status}`);
  }
  return { ok: true, verdict };
}

export type ArtifactStage = "triage" | "plan" | "build" | "verify" | "pr" | "retro";

export function runDir(issue: number): string {
  return `.factory/runs/issue-${issue}`;
}

// The one spelling of each stage's artifact filenames — readStageArtifacts,
// clearStageArtifacts and rehydrate() (see rehydrate.ts) all import these
// rather than repeating the strings.
export const COMMENT_FILENAMES: Record<ArtifactStage, string> = {
  triage: "triage-comment.md",
  plan: "plan-comment.md",
  build: "status-comment.md",
  verify: "verdict-comment.md",
  pr: "pr-body.md",
  retro: "retro-comment.md",
};

export const JSON_FILENAMES: Record<ArtifactStage, string> = {
  triage: "triage.json",
  plan: "plan.json",
  build: "build.json",
  verify: "verdict.json",
  pr: "pr.json",
  retro: "retro.json",
};

// Undefined for a missing file, and also for one that is too big, not JSON, or
// not a single object: the caller reports "no valid <stage>.json" either way.
async function readJson<T>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size > MAX_STEP_JSON_BYTES) return undefined;
  try {
    const value: unknown = await file.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

// What the runner measured after build, tied to the tree it measured, so a
// read-only verifier can trust it instead of re-running the gates.
export interface GateEvidence {
  readonly line: string;
  readonly status: string;
  readonly tree: string;
}

export async function writeGateEvidence(cwd: string, issue: number, evidence: GateEvidence): Promise<void> {
  await mkdir(`${cwd}/${runDir(issue)}`, { recursive: true });
  await Bun.write(`${cwd}/${runDir(issue)}/gate.json`, `${JSON.stringify(evidence)}\n`);
}

export async function readGateEvidence(cwd: string, issue: number): Promise<GateEvidence | undefined> {
  const v = await readJson<Partial<GateEvidence>>(`${cwd}/${runDir(issue)}/gate.json`);
  return typeof v?.tree === "string" && typeof v.line === "string" && typeof v.status === "string"
    ? { line: v.line, status: v.status, tree: v.tree }
    : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return await file.text();
}

export interface StageArtifacts {
  comment?: string;
  question?: string;
  json?: unknown;
}

// Reads whatever a stage left behind in cwd/.factory/runs/issue-<N>/ after the
// executor finished. cwd is the worktree the stage ran in.
export async function readStageArtifacts(cwd: string, issue: number, stage: ArtifactStage): Promise<StageArtifacts> {
  const base = `${cwd}/${runDir(issue)}`;
  const comment = await readText(`${base}/${COMMENT_FILENAMES[stage]}`);
  const question = await readText(`${base}/question-comment.md`);
  const json = await readJson(`${base}/${JSON_FILENAMES[stage]}`);
  return { comment, question, json };
}

// Deletes a stage's own output files before it runs again, so a re-run (a
// needs-info resume, a revise, a reject-then-rebuild) never reads a stale
// artifact left over from an earlier round (audit finding #9).
export async function clearStageArtifacts(cwd: string, issue: number, stage: ArtifactStage): Promise<void> {
  const base = `${cwd}/${runDir(issue)}`;
  const names = [COMMENT_FILENAMES[stage], JSON_FILENAMES[stage], "question-comment.md"];
  await Promise.all(names.map((n) => unlink(`${base}/${n}`).catch(() => {})));
}
