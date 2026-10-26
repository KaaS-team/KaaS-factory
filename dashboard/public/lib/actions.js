// What a person can do to a run, and what the page says once it is done. The button and the
// confirmation share one noun ("Approve plan", then "Plan approved"), so nobody wonders which
// click did what. tests/dashboard-ui.test.ts pins the pairing.

export const ACTION_LABEL = {
  approve: "Approve plan",
  revise: "Request changes",
  answer: "Send answer",
  retry: "Retry run",
  cancel: "Cancel run",
  merge: "Approve and merge",
};
export const ACTION_DONE = {
  approve: "Plan approved",
  revise: "Changes requested",
  answer: "Answer sent",
  retry: "Run retried",
  cancel: "Run cancelled",
  merge: "Approved and merged",
};
export const REVIEW_KINDS = new Set(["review-pr", "merge-dry-run"]);
export const actionLabel = (item, a) => (REVIEW_KINDS.has(item.kind) && a === "cancel" ? "Close" : ACTION_LABEL[a]);
export const needsText = (a) => a === "revise" || a === "answer";

// A question that lists its choices ("1. Keep the old name" or "- Rename it") answers in one tap.
export function choicesOf(ask) {
  const lines = (ask || "").split("\n").map((l) => l.trim());
  const picks = lines.map((l) => /^(?:\d+[.)]|[-*])\s+(?:\[ \]\s+)?(.{1,80})$/.exec(l)?.[1]).filter(Boolean);
  return picks.length >= 2 && picks.length <= 5 ? picks : [];
}

// Messages wait `delay` ms before they go, so Undo can still take one back.
export function createSendQueue({ delay = 5000, send, onChange = () => {}, timers = globalThis }) {
  const queued = [];
  const drop = (entry) => {
    const i = queued.indexOf(entry);
    if (i >= 0) queued.splice(i, 1);
  };
  return {
    get items() {
      return [...queued];
    },
    enqueue(message) {
      const entry = { ...message, at: Date.now() };
      entry.timer = timers.setTimeout(async () => {
        drop(entry);
        onChange();
        await send(entry);
      }, delay);
      queued.push(entry);
      onChange();
      return entry;
    },
    undo(entry) {
      timers.clearTimeout(entry.timer);
      drop(entry);
      onChange();
      return entry;
    },
  };
}
