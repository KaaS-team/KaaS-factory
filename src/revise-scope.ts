// A revise run reviews only what changed since the last reviewed sha, plus the findings an earlier
// verdict confirmed. The sha is read from the latest verify marker (`reviewedSha`); without one the
// scope is empty and the run reviews the whole diff, as before.

import { latestDataFor, parseDataMarkers } from "./derive";
import type { GhComment } from "./github";

export interface ReviseScope {
  readonly sha: string;
  readonly findings: string[];
}

const SHA_RE = /^[0-9a-f]{7,40}$/;

function findingText(f: unknown): string | undefined {
  if (typeof f === "string") return f || undefined;
  const what = (f as { what?: unknown } | null)?.what;
  return typeof what === "string" && what ? what : undefined;
}

export function reviseScope(comments: readonly GhComment[]): ReviseScope | undefined {
  const verdict = latestDataFor(parseDataMarkers(comments), "verify") as
    | { reviewedSha?: unknown; findings?: unknown }
    | undefined;
  const sha = verdict?.reviewedSha;
  if (typeof sha !== "string" || !SHA_RE.test(sha)) return undefined;
  const findings = Array.isArray(verdict?.findings)
    ? verdict.findings.map(findingText).filter((t) => t !== undefined)
    : [];
  return { sha, findings };
}

export function scopePrompt(scope: ReviseScope | undefined): string {
  if (!scope) return "";
  let out = `Review only the diff since the last reviewed commit: git diff ${scope.sha}..HEAD. Do not re-review earlier changes.\n`;
  for (const f of scope.findings) out += `Earlier confirmed finding: ${f}\n`;
  return out;
}
