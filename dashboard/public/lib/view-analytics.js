// Analytics: what the factory delivers, and, for an operator, what it costs.

import { h, heading, isOperator, money, quiet, stateOr } from "./core.js";
import { formatElapsed } from "./run-metrics.js";

function bars(title, buckets) {
  const max = Math.max(...buckets.map((b) => b.costUsd), 0.0001);
  return h(
    "div",
    null,
    h("h2", null, title),
    h(
      "div",
      { class: "bars" },
      buckets.map((b) =>
        h(
          "div",
          { class: "bar" },
          h("span", null, b.key),
          h(
            "div",
            { class: "bar-track" },
            h("div", { class: "bar-fill", style: `width:${Math.max(2, (b.costUsd / max) * 100)}%` }),
          ),
          h(
            "span",
            { class: "bar-note" },
            `${money(b.costUsd)}, ${b.attempts} ${b.attempts === 1 ? "attempt" : "attempts"}, ${formatElapsed(b.avgDurationMs)} on average`,
          ),
        ),
      ),
    ),
  );
}

export function analyticsView() {
  const op = isOperator();
  return h(
    "section",
    null,
    heading("Analytics", op ? "What the factory delivers, and what it costs." : "What the factory delivers."),
    stateOr("analytics", (a) =>
      !a.byStage.length
        ? quiet("No stage has finished yet", "Numbers appear after the first run completes a stage.")
        : h(
            "div",
            null,
            h(
              "div",
              { class: "kpis" },
              [
                [
                  a.successRate == null ? "None yet" : `${Math.round(a.successRate * 1000) / 10}%`,
                  "Runs that shipped, of those finished",
                ],
                [String(a.runs), "Runs started"],
                ...(op
                  ? [
                      [money(a.spend7dUsd), "Spent in 7 days"],
                      [money(a.spend30dUsd), "Spent in 30 days"],
                      ...(a.savings.runs
                        ? [[money(a.savings.savedUsd), `Saved by model routing, ${a.savings.runs} priced attempts`]]
                        : []),
                    ]
                  : []),
              ].map(([v, l]) =>
                h("div", { class: "kpi" }, h("span", { class: "value" }, v), h("span", { class: "label" }, l)),
              ),
            ),
            op
              ? [
                  bars("Cost by stage", a.byStage),
                  bars("Cost by agent", a.byAgent),
                  bars("Cost by model", a.byModel ?? []),
                ]
              : null,
          ),
    ),
  );
}
