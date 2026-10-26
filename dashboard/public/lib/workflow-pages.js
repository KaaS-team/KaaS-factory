// The Events and Minions pages and the workflow form. The form never writes the repo: it posts
// the changed step fields and the server opens a PR (dashboard/workflow-routes.ts).
export const ROUTED = (w) =>
  w.routedTypes.includes("*")
    ? "The repo's workflow"
    : w.routedTypes.length
      ? `Issue types: ${w.routedTypes.join(", ")}`
      : "Not routed";

export const EXTRA_NAV = [
  ["events", "Events"],
  ["minions", "Minions"],
];
export const EXTRA_ICONS = {
  events: "M4 6h16M4 12h10M4 18h6M18 14l3 3-3 3",
  minions: "M12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 20v-2a6 6 0 0 1 12 0v2",
};
export const EXTRA_LOADERS = { events: ["events", "/api/events"], minions: ["minions", "/api/minions"] };
export const FORM_FIELDS = ["agent", "timeout", "retries"];

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

// The step fields a person filled in; an empty box leaves the field as it is.
export function formFrom(entries) {
  const form = {};
  for (const [step, field, value] of entries) {
    const v = String(value).trim();
    if (!v) continue;
    (form[step] ||= {})[field] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return form;
}

export function workflowEditor({ h, post }, w) {
  const out = h("div", { class: "muted", role: "status" });
  const inputs = w.steps.flatMap((st) =>
    FORM_FIELDS.map((f) => ({
      step: st.id,
      field: f,
      el: h("input", { name: `${st.id}.${f}`, "aria-label": `${st.id} ${f}`, size: 8 }),
    })),
  );
  const submit = async (e) => {
    e.preventDefault();
    const form = formFrom(inputs.map((i) => [i.step, i.field, i.el.value]));
    out.textContent = "Opening a PR";
    try {
      const r = await post("/api/workflow-edit", { name: w.name, form });
      out.replaceChildren("PR opened: ", h("a", { href: r.prUrl, target: "_blank", rel: "noopener" }, r.prUrl));
    } catch (err) {
      out.textContent = err.message;
    }
  };
  return h(
    "details",
    null,
    h("summary", null, "Propose a change"),
    h(
      "form",
      { onsubmit: submit },
      w.steps.map((st) =>
        h(
          "div",
          null,
          h("code", null, st.id),
          ...inputs.filter((i) => i.step === st.id).map((i) => h("label", null, ` ${i.field} `, i.el)),
        ),
      ),
      h("button", { type: "submit" }, "Open a PR"),
      out,
    ),
  );
}

export function extraViews({ h, heading, stateOr, quiet, post }) {
  const replay = async (id, cell) => {
    try {
      const r = await post(`/api/events/${encodeURIComponent(id)}/replay`, {});
      cell.textContent = `Sent again to ${r.queued} sink(s)`;
    } catch (err) {
      cell.textContent = err.message;
    }
  };
  const events = () =>
    h(
      "section",
      null,
      heading("Events", "Every event the factory emitted or received, newest last, and where each was delivered."),
      stateOr("events", (d) =>
        !d.events.length
          ? quiet("No events yet", "Events appear here as issues move and minions run.")
          : table(
              h,
              ["Time", "Type", "Subject", "Delivered", ""],
              d.events.map((e) => {
                const cell = h("td");
                const sent =
                  e.deliveries.map((x) => `${x.status}`).join(", ") || (e.direction === "in" ? "received" : "no sink");
                cell.append(
                  e.deliveries.length
                    ? h("button", { type: "button", onclick: () => replay(e.id, cell) }, "Replay")
                    : "",
                );
                return h(
                  "tr",
                  null,
                  h("td", null, e.time),
                  h("td", null, h("code", null, e.type)),
                  h("td", null, e.subject ?? ""),
                  h("td", null, sent),
                  cell,
                );
              }),
            ),
      ),
    );
  const minions = () =>
    h(
      "section",
      null,
      heading(
        "Minions",
        "Agent runs with no issue and no PR, the event or schedule that starts each, and its last run.",
      ),
      stateOr("minions", (d) =>
        !d.available
          ? quiet("No repo to read", d.reason)
          : !d.minions.length && !d.problems.length
            ? quiet("No minions", "Add one under .factory/minions/<name>.yml.")
            : h(
                "div",
                null,
                d.problems.map((p) => h("div", { class: "status", "data-tone": "bad" }, p)),
                table(
                  h,
                  ["Minion", "Starts on", "Workspace", "Last run"],
                  d.minions.map((m) =>
                    h(
                      "tr",
                      null,
                      h("td", null, h("strong", null, m.name), h("div", { class: "muted" }, m.description)),
                      h("td", null, m.on.event ? `Event ${m.on.event}` : `Schedule (${m.on.tz})`),
                      h("td", null, m.checkout ? "A fresh clone of the repo" : "Empty"),
                      h(
                        "td",
                        null,
                        m.lastRun
                          ? h(
                              "span",
                              { class: "status", "data-tone": m.lastRun.ok ? "ok" : "bad" },
                              `${m.lastRun.time}${m.lastRun.reason ? `: ${m.lastRun.reason}` : ""}`,
                            )
                          : "Not run yet",
                      ),
                    ),
                  ),
                ),
              ),
      ),
    );
  return { events, minions };
}
