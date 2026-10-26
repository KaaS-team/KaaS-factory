// Workflows in words a QA lead or PM can follow: which issues each one takes, what each step does,
// and where it stops for a person. The step ids and runtimes stay behind an operator's fold.

import { h, heading, isOperator, quiet, shell, state, stateOr } from "./core.js";

export const STEP_WORDS = {
  triage: "Reads the issue and decides whether it is clear enough to start",
  plan: "Writes a plan with acceptance criteria, then waits for your approval",
  build: "Writes the code and its tests, and runs the project's checks",
  verify: "A separate session checks the work against the plan",
  pr: "Opens a pull request for review",
  retro: "Notes what to do better next time",
};
const TYPE_WORDS = {
  bug: "bugs",
  feature: "features",
  docs: "docs changes",
  security: "security fixes",
  dependency: "dependency updates",
};

const NAMES = { pr: "Pull request" };
export const humanize = (id) => {
  if (NAMES[id]) return NAMES[id];
  const s = String(id).replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
};

export function stepWords(step) {
  return (
    STEP_WORDS[step.uses] ??
    STEP_WORDS[step.id] ??
    `Runs the ${humanize(step.id).toLowerCase()} step this project added`
  );
}

export function forWhom(w) {
  if (w.routedTypes.includes("*")) return "Every issue the factory picks up";
  if (!w.routedTypes.length) return "No issue type is sent here yet";
  return `Issues marked as ${w.routedTypes.map((t) => TYPE_WORDS[t] ?? t).join(", ")}`;
}

const when = (w) =>
  [
    ...w.cron.map((c) => `On a schedule: ${c.title}`),
    ...(w.events ?? []).map((t) => `When ${humanize(t).toLowerCase()} happens`),
  ].join("; ") || "When an issue is marked ready";

function workflowCard(w) {
  return h(
    "article",
    { class: "panel panel-pad workflow" },
    h(
      "header",
      null,
      h("h2", null, humanize(w.name)),
      h(
        "span",
        { class: "status", "data-tone": w.problems.length ? "bad" : "ok" },
        w.problems.length ? "Does not load" : "Ready",
      ),
    ),
    h(
      "dl",
      { class: "kv" },
      h("dt", null, "Takes"),
      h("dd", null, forWhom(w)),
      h("dt", null, "Starts"),
      h("dd", null, when(w)),
    ),
    w.problems.length
      ? h(
          "ul",
          { class: "plain-list" },
          w.problems.map((p) => h("li", { class: "error" }, p)),
        )
      : null,
    h(
      "ol",
      { class: "flow" },
      w.steps.map((s) =>
        h(
          "li",
          { "data-waits": String(s.uses === "plan" || s.id === "plan") },
          h("strong", null, humanize(s.id)),
          h("span", null, stepWords(s)),
          s.uses === "plan" || s.id === "plan"
            ? h("span", { class: "status", "data-tone": "warn" }, "Waits for you")
            : null,
        ),
      ),
    ),
    isOperator()
      ? h(
          "details",
          { class: "tech" },
          h("summary", null, "Technical detail"),
          h(
            "ul",
            { class: "plain-list" },
            w.steps.map((s) =>
              h(
                "li",
                null,
                h("code", null, s.uses === s.id ? s.id : `${s.id} uses ${s.uses}`),
                s.runtime ? ` on ${s.runtime}` : "",
              ),
            ),
          ),
          h("p", { class: "muted" }, w.source === "repo" ? "Defined in .factory/workflows" : "Built into the runner"),
        )
      : null,
  );
}

export function workflowsView() {
  return h(
    "section",
    null,
    heading(
      "Workflows",
      "What the factory does with each kind of issue, step by step.",
      h(
        "a",
        {
          class: "btn",
          href: "#/settings",
          onclick: () => {
            state.settingsTab = "automation";
            shell.render();
          },
        },
        "Change what runs automatically",
      ),
    ),
    stateOr("workflows", (d) =>
      !d.available
        ? quiet("No project to read", d.reason)
        : h(
            "div",
            { class: "workflows" },
            d.problems.length
              ? h(
                  "div",
                  { class: "notice", role: "status" },
                  h("strong", null, "Some workflows do not load. "),
                  d.problems.join("; "),
                )
              : h("p", { class: "muted" }, "Every workflow loads, and every issue type goes to one that exists."),
            d.workflows.map(workflowCard),
          ),
    ),
  );
}
