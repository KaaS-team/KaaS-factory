// The board: open issues by where they sit. A workflow's own step (a factory:linting label) gets its
// own column after verify, so an issue in a custom step is on the board, not only in the list.

import { h, heading, quiet, runHref, state, stateOr } from "./core.js";
import { humanize } from "./view-workflows.js";

const BEFORE = [
  ["intake", "Ready to start"],
  ["triage", "Triage"],
  ["plan", "Plan"],
  ["build", "Build"],
  ["verify", "Verify"],
];
const AFTER = [
  ["pr", "Pull request"],
  ["attention", "Needs a human"],
];

// Each custom step is its own column, keyed "step:<name>", in the order the cards first name them.
export function boardColumns(cards) {
  const steps = [...new Set(cards.filter((c) => c.column === "step" && c.step).map((c) => c.step))];
  return [...BEFORE, ...steps.map((s) => [`step:${s}`, humanize(s)]), ...AFTER].map(([id, title]) => ({
    id,
    title,
    cards: cards.filter((c) => (c.column === "step" ? `step:${c.step}` : c.column) === id),
  }));
}

export function boardView() {
  return h(
    "section",
    null,
    heading("Board", "Every open issue, by the step it is on."),
    stateOr("board", ({ cards, repo }) =>
      !cards.length
        ? quiet("No open issues", "Start a task on the Line, or mark an issue ready.")
        : h(
            "div",
            { class: "board" },
            boardColumns(cards).map((col) =>
              h(
                "section",
                { class: "board-col", "data-col": col.id, "aria-label": col.title },
                h("h2", null, col.title, h("span", { class: "count" }, String(col.cards.length))),
                col.cards.map((c) =>
                  h(
                    "a",
                    { class: "board-card", href: runHref(repo ?? state.repo, c.issue) },
                    h("strong", null, `#${c.issue}`),
                    ` ${c.title}`,
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}
