// Fleet: the coding agents the factory can run. Commands and versions are operator detail.

import { h, heading, isOperator, quiet, stateOr, table } from "./core.js";

export function agentsView() {
  if (!isOperator())
    return h(
      "section",
      null,
      heading("Fleet", "The coding agents the factory can run."),
      quiet("Only operators see the fleet", "Ask an owner for the operator role."),
    );
  return h(
    "section",
    null,
    heading("Fleet", "The coding agents the factory can run, and which stages each one serves."),
    stateOr("agents", (a) =>
      !a.agents.length
        ? quiet("No agents configured", "Add one under agents in .factory/config.json.")
        : table(
            ["Agent", "Command", "Installed", "Pinned version", "Verified live", "Doctor", "Stages"],
            a.agents.map((r) =>
              h(
                "tr",
                null,
                h(
                  "td",
                  null,
                  h("span", { class: "status", "data-tone": r.configured ? "ok" : "" }, r.name),
                  r.configured ? null : h("span", { class: "muted" }, " not configured"),
                ),
                h("td", null, r.binary),
                h(
                  "td",
                  null,
                  !r.configured ? "Not configured" : r.installed ? r.version || "Installed" : "Not installed",
                ),
                h("td", null, r.pin || "Not pinned"),
                h(
                  "td",
                  null,
                  h(
                    "span",
                    { class: "status", "data-tone": r.verified ? "ok" : "warn" },
                    r.verified ? "Verified" : "Verified by participants: not yet",
                  ),
                ),
                h(
                  "td",
                  null,
                  r.checks.length
                    ? h(
                        "ul",
                        { class: "plain-list" },
                        r.checks.filter((c) => !c.ok).map((c) => h("li", { title: c.detail }, c.name)),
                      )
                    : "",
                  r.checks.length && r.checks.every((c) => c.ok) ? "All checks pass" : null,
                ),
                h("td", null, r.stages.length ? r.stages.join(", ") : "None"),
              ),
            ),
          ),
    ),
  );
}
