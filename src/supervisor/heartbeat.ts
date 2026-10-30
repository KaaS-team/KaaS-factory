// From push time and session age, say whether a launched run is on track, stale or finished.
export const STALE_AFTER_MIN = 20;
const MINUTE = 60_000;

export type Verdict = "on-track" | "stale" | "finished";

export interface SessionSnapshot {
  issue: number;
  branch: string;
  startedAt: string;
  lastPushAt?: string;
  endedAt?: string;
  prNumber?: number;
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / MINUTE));

export function heartbeat(
  s: SessionSnapshot,
  now: number,
  staleAfterMin = STALE_AFTER_MIN,
): { verdict: Verdict; sentence: string } {
  const head = `Issue #${s.issue} (\`${s.branch}\`)`;
  if (s.prNumber !== undefined) {
    return { verdict: "finished", sentence: `${head} finished with pull request #${s.prNumber}: review it.` };
  }
  if (s.endedAt) {
    const sentence = s.lastPushAt
      ? `${head} ended after a push but has no pull request: open one from the branch.`
      : `${head} ended without a push: read the session log and relaunch.`;
    return { verdict: "finished", sentence };
  }
  const started = Date.parse(s.startedAt);
  if (Number.isNaN(started)) {
    return {
      verdict: "stale",
      sentence: `${head} has an unreadable start time: open the session and check it.`,
    };
  }
  const age = minutes(now - started);
  const stale = !s.lastPushAt && now - started >= staleAfterMin * MINUTE;
  if (stale) {
    return {
      verdict: "stale",
      sentence: `${head} started ${age} minutes ago with no push: open the session and either nudge it or stop it and relaunch.`,
    };
  }
  const pushed = s.lastPushAt ? Date.parse(s.lastPushAt) : Number.NaN;
  const since = Number.isNaN(pushed) ? "no push is due yet" : `last push ${minutes(now - pushed)} minutes ago`;
  return { verdict: "on-track", sentence: `${head} is on track: started ${age} minutes ago, ${since}.` };
}
