// The run page: the agent's live activity and the proof a reviewer needs, read from the
// files a run already leaves. A person following the run never has to know which JSON
// file holds what.

import { existsSync, readFileSync } from "node:fs";
import { plain } from "../src/display";
import { StreamView, type StreamItem } from "../src/view";

// The whole file is parsed each call: a tool result names its call by id, so a mid-file
// start would lose the tool's name. A stream is a few MB at most.
export function liveItems(file: string, from = 0): { items: StreamItem[]; next: number } {
  if (!existsSync(file)) return { items: [], next: 0 };
  const view = new StreamView();
  const all = readFileSync(file, "utf8").split("\n").flatMap((l) => view.items(l));
  const start = from > all.length ? 0 : from;
  return { items: all.slice(start), next: all.length };
}

export interface Criterion { id: string; what: string; check: string; status: string }
export interface ProofView {
  criteria: Criterion[];
  gate: { status: string; passed: number; failed: number; skipped: number; nonBlocking: string[] } | null;
  revert: { status: string; reverted: string[]; failedTests: string[] } | null;
  findings: { severity: string; what: string; fix?: string }[];
  result: string | null;
}

const CRITERION = /^\s*[-*]\s+\*\*(AC-\d+):\*\*\s*(.+)$/gm;
const FAILED_TEST = /\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm;

function gateFrom(line: string | undefined): ProofView["gate"] {
  if (!line) return null;
  const field = (k: string) => new RegExp(`\\b${k}=(\\S*)`).exec(line)?.[1] ?? "";
  return { status: field("status"), passed: Number(field("passed")) || 0, failed: Number(field("failed")) || 0, skipped: Number(field("skipped")) || 0, nonBlocking: field("failed_gates").split(",").filter(Boolean) };
}

// Criterion text comes from the plan the human approved; its status from the verdict.
export function proofView(input: { planComment?: string; verdict?: unknown; gateLine?: string; proof?: unknown }): ProofView {
  const verdict = (input.verdict ?? {}) as { result?: string; criteria?: { id: string; status: string }[]; findings?: { severity: string; what: string; fix?: string }[] };
  const status = new Map((verdict.criteria ?? []).map((c) => [c.id, c.status]));
  const criteria = [...plain(input.planComment ?? "").matchAll(CRITERION)].map(([, id, text]) => {
    const [what, check = ""] = text!.split(/:\s*checked by\s*/i);
    return { id: id!, what: what!.trim(), check: check.trim(), status: status.get(id!) ?? "pending" };
  });
  const proof = input.proof as { status?: string; reverted?: string[]; tail?: string } | undefined;
  const revert = proof?.status
    ? { status: proof.status, reverted: proof.reverted ?? [], failedTests: [...new Set([...plain(proof.tail ?? "").matchAll(FAILED_TEST)].map((m) => m[1]!.replace(/^.+? > /, "")))] }
    : null;
  const findings = (verdict.findings ?? []).map((f) => ({ severity: f.severity, what: plain(f.what), ...(f.fix ? { fix: plain(f.fix) } : {}) }));
  return { criteria, gate: gateFrom(input.gateLine), revert, findings, result: verdict.result ?? null };
}
