// Runs: every run the factory has started, newest first, filtered by what it needs.

import {
  age,
  h,
  heading,
  inRepo,
  isOperator,
  money,
  quiet,
  runHref,
  shell,
  short,
  state,
  stateOr,
  statusText,
  table,
  tone,
} from "./core.js";
import { ACTIVE, WAITING } from "./stations.js";

const FILTERS = [
  ["all", "All", () => true],
  ["active", "Active", (r) => ACTIVE.has(r.status)],
  ["needs", "Needs you", (r) => WAITING.has(r.status)],
  ["done", "Finished", (r) => ["shipped", "cancelled", "rejected"].includes(r.status)],
];

export function runsView() {
  return h(
    "section",
    null,
    heading("Runs", "Every run the factory has started, newest first."),
    stateOr("runs", ({ runs }) => {
      const pick = FILTERS.find((f) => f[0] === state.filter)[2];
      runs = runs.filter((r) => inRepo(r.repo ?? state.repo));
      const rows = runs.filter(pick);
      const op = isOperator();
      const open = (r) => (location.hash = runHref(r.repo, r.issue));
      return h(
        "div",
        null,
        h(
          "div",
          { class: "tabs", role: "group", "aria-label": "Filter runs" },
          FILTERS.map(([id, label, fn]) =>
            h(
              "button",
              {
                class: "tab",
                type: "button",
                "aria-pressed": String(state.filter === id),
                onclick: () => {
                  state.filter = id;
                  shell.render();
                },
              },
              `${label} ${runs.filter(fn).length}`,
            ),
          ),
        ),
        rows.length
          ? table(
              ["Issue", "Status", "Stage", ...(op ? ["Cost"] : []), "Updated"],
              rows.map((r) =>
                h(
                  "tr",
                  {
                    "data-href": r.issue,
                    tabindex: "0",
                    onclick: () => open(r),
                    onkeydown: (e) => e.key === "Enter" && open(r),
                  },
                  h(
                    "td",
                    null,
                    `#${r.issue} ${r.title}`,
                    state.repos.length > 1 ? h("div", { class: "muted" }, short(r.repo ?? state.repo)) : null,
                  ),
                  h("td", null, h("span", { class: "status", "data-tone": tone(r.status) }, statusText(r.status))),
                  h("td", null, r.stage),
                  op ? h("td", { class: "num" }, money(r.cost_usd)) : null,
                  h("td", { class: "num" }, age(r.updated_at)),
                ),
              ),
              3,
            )
          : quiet(
              "No runs match",
              state.filter === "all" ? "Label an issue factory:ready to start one." : "Try another filter.",
            ),
      );
    }),
  );
}
