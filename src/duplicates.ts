// Duplicate and superseded-issue checks, run once per poll from resolveBlockers.
// Word and path matching only; no model call. Tests: tests/duplicates.test.ts.

import type { GhIssue, ScmPort } from "./github";
import { LABEL } from "./labels";

type Titled = { title: string; body: string };

export function titleWords(title: string): Set<string> {
  return new Set(title.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

export function filesOf(body: string): string[] {
  const section = body.match(/^##\s+Files\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im)?.[1] ?? "";
  return [...section.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!).sort();
}

export function likelyDuplicate(a: Titled, b: Titled): boolean {
  const fa = filesOf(a.body);
  const fb = filesOf(b.body);
  if (fa.length === 0 || fa.join("\n") !== fb.join("\n")) return false;
  const wb = titleWords(b.title);
  let shared = 0;
  for (const w of titleWords(a.title)) if (wb.has(w)) shared++;
  if (shared < 4) return false;
  return true;
}

export function supersededBy(body: string): number | undefined {
  const m = body.match(/^\s*(?:Superseded by|Duplicate of)\s+#(\d+)/im);
  return m ? Number(m[1]) : undefined;
}

const DUPLICATE_MARK = "Possible duplicate of #";

export async function reconcileDuplicates(github: ScmPort, repo: string, ready: readonly GhIssue[]): Promise<number[]> {
  if (ready.length === 0) return [];
  const parked: number[] = [];
  const open = await github.listOpenIssues(repo);

  for (const issue of ready) {
    const target = supersededBy(issue.body);
    if (target !== undefined) {
      const replacement = await github.getIssue(repo, target).catch(() => undefined);
      if (replacement?.state === "CLOSED" && replacement.stateReason !== "NOT_PLANNED") {
        await github.commentIssue(repo, issue.number, `Shipped in #${target}.`);
        await github.closeIssue(repo, issue.number);
        parked.push(issue.number);
      }
      continue;
    }
    const original = open.find((o) => o.number < issue.number && likelyDuplicate(issue, o));
    if (!original) continue;
    // A comment already there means an earlier poll parked it and a human moved it back.
    if (!issue.comments?.some((c) => c.body.includes(DUPLICATE_MARK))) {
      await github.commentIssue(
        repo,
        issue.number,
        `${DUPLICATE_MARK}${original.number}. Close this one or say how it differs.`,
      );
    }
    await github.setStateLabel(
      repo,
      issue.number,
      issue.labels.map((l) => l.name),
      LABEL.needsInfo,
    );
    parked.push(issue.number);
  }
  return parked;
}
