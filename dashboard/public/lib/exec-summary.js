// The inbox brief: what the factory did this week and what it waits on, in sentences a
// maintainer reads in five seconds. Pure, so tests pin every phrasing.
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function waited(iso, now) {
  const hours = Math.floor((now - Date.parse(iso)) / 3_600_000);
  if (hours < 1) return "under an hour";
  if (hours < 48) return plural(hours, "hour");
  return plural(Math.floor(hours / 24), "day");
}

export function execSummary(analytics, items, now = Date.now()) {
  const sentences = [];
  if (analytics) {
    const { started, shipped, failed } = analytics.week;
    sentences.push(
      started || shipped || failed
        ? `This week ${plural(started, "run")} started, ${shipped} shipped and ${failed} failed.`
        : "No runs this week.",
    );
  }
  if (items.length) {
    const oldest = items.reduce((a, b) => (Date.parse(b.waitingSince) < Date.parse(a.waitingSince) ? b : a));
    sentences.push(
      items.length === 1
        ? `One item waits on you, for ${waited(oldest.waitingSince, now)}.`
        : `${items.length} items wait on you; the oldest for ${waited(oldest.waitingSince, now)}.`,
    );
  } else sentences.push("Nothing waits on you.");
  if (analytics?.spend7dUsd) sentences.push(`$${analytics.spend7dUsd.toFixed(2)} spent in the last 7 days.`);
  return sentences.join(" ");
}
