// An escaped defect is a merged change later reverted or an issue reopened; each opens one follow-up
// issue that asks for a regression test or a rule that would have caught it; titles start
// `Escaped defect:` so a rerun never opens a second one.

export const FOLLOW_UP_PREFIX = "Escaped defect:";

export interface Escape {
  kind: "revert" | "reopen";
  ref: string;
  why: string;
  sha?: string;
}

export function followUpIssue(o: {
  kind: "revert" | "reopen";
  ref: string;
  why: string;
  sha?: string;
  link?: string;
}): {
  title: string;
  body: string;
} {
  const what = o.kind === "revert" ? "reverted" : "reopened";
  const happened = [o.why, o.sha ? `sha ${o.sha}` : "", o.link ?? ""].filter(Boolean).join(" ");
  return {
    title: `${FOLLOW_UP_PREFIX} ${what} ${o.ref}`,
    body: [
      `What happened: ${happened}`,
      "",
      `The fix PR must add a regression test that fails at the ${what} change and passes after the fix, or a rule (a lint, a gate step, a tamper pattern) that refuses it.`,
      "The loop may add tests and rules but never remove one.",
    ].join("\n"),
  };
}

export function revertsIn(log: string): Escape[] {
  const out: Escape[] = [];
  for (const record of log.split("\x1e")) {
    const [sha, subject, body] = record.trim().split("\x00");
    const m = /This reverts commit ([0-9a-f]{7,40})/.exec(body ?? "");
    if (!sha || !m) continue;
    out.push({
      kind: "revert",
      ref: m[1]!.slice(0, 7),
      sha: m[1]!,
      why: `reverted by ${sha.slice(0, 7)}: ${subject ?? ""}`,
    });
  }
  return out;
}

export function reopenedIn(events: readonly unknown[], sinceIso: string): Escape[] {
  const out: Escape[] = [];
  const seen = new Set<number>();
  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const { event, created_at: at, issue } = e as { event?: unknown; created_at?: unknown; issue?: unknown };
    if (event !== "reopened" || typeof at !== "string" || at < sinceIso) continue;
    const { number, title } = (issue ?? {}) as {
      number?: unknown;
      title?: unknown;
    };
    if (typeof number !== "number" || typeof title !== "string" || title.startsWith(FOLLOW_UP_PREFIX)) continue;
    if (seen.has(number)) continue;
    seen.add(number);
    out.push({ kind: "reopen", ref: `#${number}`, why: `reopened: ${title}` });
  }
  return out;
}

export function newFollowUps(found: readonly Escape[], existingTitles: readonly string[]): Escape[] {
  const seen = new Set(existingTitles);
  return found.filter((e) => !seen.has(followUpIssue(e).title) && Boolean(seen.add(followUpIssue(e).title)));
}
