// The Settings page's fleet pieces: each machine's heartbeat, each runtime's last probe, and the
// issue leases. Plain functions of /api/settings and `h`, so tests pin every phrasing.

const table = (h, cols, rows) =>
  h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          cols.map((c) => h("th", null, c)),
        ),
      ),
      h("tbody", null, rows),
    ),
  );

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

// A runtime nothing in the repo uses is never dialled, so it has no row in `health`.
export function healthText(health) {
  if (!health) return { text: "Not probed", tone: "" };
  return health.ok ? { text: `Up, ${health.ms} ms`, tone: "live" } : { text: `Down: ${health.detail}`, tone: "bad" };
}

export function healthCell(health, h) {
  const t = healthText(health);
  return h("td", null, h("span", { class: "status", "data-tone": t.tone }, t.text));
}

export function slotsText(d) {
  return `${d.slotsInUse} of ${d.slots} in use`;
}

export function machinesPanel(d, h, now = Date.now()) {
  if (!d.machines.length)
    return h("p", { class: "muted" }, "No machine has reported yet. A watcher reports on every poll.");
  return table(
    h,
    ["Machine", "Tags", "Slots in use", "Last heartbeat", "Running"],
    d.machines.map((m) =>
      h(
        "tr",
        null,
        h("td", null, h("span", { class: "status", "data-tone": m.stale ? "" : "live" }, m.name)),
        h("td", null, m.tags.length ? m.tags.join(", ") : "None"),
        h("td", null, `${m.used} of ${m.slots}`),
        h("td", null, m.stale ? `${ago(now - m.heartbeatAt)}, gone quiet` : ago(now - m.heartbeatAt)),
        h("td", null, m.tasks.length ? m.tasks.join(", ") : "Idle"),
      ),
    ),
  );
}

export function leaseState(l, now = Date.now()) {
  if (l.live) return `Held, expires in ${Math.max(1, Math.round((l.expiresAt - now) / 1000))}s`;
  return l.expiresAt === 0 ? "Released" : "Expired";
}

export function leasesPanel(d, h, quiet, now = Date.now()) {
  if (d.leasesError) return h("p", { class: "error" }, `Could not read the lease refs: ${d.leasesError}`);
  if (!d.leases.length) return quiet("No leases", "A worker takes refs/factory/lease/<issue> while it runs an issue.");
  return table(
    h,
    ["Issue", "Holder", "State"],
    d.leases.map((l) =>
      h(
        "tr",
        null,
        h("td", null, l.key),
        h("td", null, l.holder),
        h("td", null, h("span", { class: "status", "data-tone": l.live ? "live" : "" }, leaseState(l, now))),
      ),
    ),
  );
}
