// The Line: the home page. What needs you, each run's stage strip, what just happened, and a
// composer that files a new task the way a person would file an issue.

import {
  age,
  glyph,
  glyphKind,
  h,
  heading,
  initials,
  inRepo,
  isOperator,
  money,
  plural,
  post,
  quiet,
  repoOf,
  runHref,
  shell,
  short,
  state,
  stateOr,
  statusText,
  svg,
} from "./core.js";
import { formatElapsed } from "./run-metrics.js";
import { ACTIVE, stationStates, WAITING } from "./stations.js";

export const KIND_HEADLINE = {
  "approve-plan": "A plan is waiting for your approval",
  "answer-question": "The factory has a question for you",
  "review-pr": "A pull request is ready for your review",
  "merge-dry-run": "A pull request is ready to merge",
  parked: "A run needs a human",
  failed: "A run failed",
  budget: "A run hit its budget",
  "stale-pr": "A pull request has gone quiet",
};
const REPO_ICON = "M5 5h14v14H5zM9 5v14";
const TYPES = [
  ["feature", "A feature"],
  ["bug", "A bug fix"],
  ["docs", "Docs"],
  ["", "Let triage decide"],
];

export function stationsFor(row) {
  return stationStates(row.run, row.stages).map(({ name, ms, live, failed, done, waiting }) => {
    const grow = Math.max(1, Math.min(8, Math.round(ms / 30000)));
    return {
      name,
      grow,
      node: h("div", {
        class: "station",
        style: `flex-grow:${grow}`,
        "data-done": done,
        "data-live": live,
        "data-failed": failed,
        "data-waiting": waiting,
        title: `${name}${ms ? `, ${formatElapsed(ms)}` : ""}`,
      }),
    };
  });
}

function lineRow(row) {
  const { run } = row;
  const needs = WAITING.has(run.status);
  const repo = repoOf(row);
  const meta = needs
    ? "Needs you"
    : ACTIVE.has(run.status)
      ? run.stage
      : run.status === "shipped"
        ? age(run.updated_at)
        : statusText(run.status);
  return h(
    "button",
    {
      class: "line-row",
      type: "button",
      title: needs && run.reason ? run.reason : null,
      onclick: () => (needs ? shell.go("inbox", run.issue, repo) : (location.hash = runHref(repo, run.issue))),
    },
    glyph(glyphKind(run.status), statusText(run.status)),
    h("span", { class: "line-id" }, `#${run.issue}`),
    h("span", { class: "line-title" }, run.title),
    h("span", { class: "line-repo" }, short(repo)),
    h(
      "div",
      { class: "stations-col" },
      h(
        "div",
        { class: "stations", role: "img", "aria-label": `Stage: ${run.stage}` },
        stationsFor(row).map((s) => s.node),
      ),
    ),
    h("span", { class: "line-cost" }, isOperator() ? money(run.cost_usd) : ""),
    h("span", { class: "line-state", "data-needs": needs }, meta),
  );
}

// One line per run, newest first: who did what last, from the run row alone.
function activityOf(row) {
  const { run } = row;
  const agent = row.stages.at(-1)?.agent ?? "factory";
  const pr = /\/pull\/(\d+)/.exec(run.pr_url || "")?.[1];
  if (run.status === "shipped")
    return { actor: "factory", what: pr ? `opened pull request #${pr}` : "shipped the run" };
  if (["failed", "rejected"].includes(run.status))
    return { actor: agent, what: `stopped at ${run.stage}`, quote: run.reason };
  if (WAITING.has(run.status))
    return { actor: "factory", what: `is waiting on you after ${run.stage}`, quote: run.reason };
  if (ACTIVE.has(run.status)) return { actor: agent, what: `is working on ${run.stage}` };
  return { actor: "factory", what: `marked it ${statusText(run.status)}` };
}

function activity(rows) {
  const recent = [...rows].sort((x, y) => (y.run.updated_at || "").localeCompare(x.run.updated_at || "")).slice(0, 8);
  return h(
    "aside",
    { class: "section" },
    h("div", { class: "section-head" }, h("h2", null, "Activity")),
    h(
      "ul",
      { class: "activity" },
      recent.map((row) => {
        const e = activityOf(row);
        return h(
          "li",
          null,
          h("span", { class: "avatar", "data-bot": e.actor === "factory", "aria-hidden": "true" }, initials(e.actor)),
          h(
            "div",
            null,
            h("p", { class: "what" }, h("strong", null, e.actor), ` ${e.what}`),
            e.quote ? h("p", { class: "quote" }, e.quote) : null,
            h("p", { class: "sub" }, `#${row.run.issue} ${row.run.title}, ${age(row.run.updated_at)} ago`),
          ),
        );
      }),
    ),
  );
}

function repoCards(rows) {
  const by = new Map();
  for (const row of rows) by.set(repoOf(row), [...(by.get(repoOf(row)) || []), row.run]);
  if (!by.size) return null;
  return h(
    "div",
    { class: "section" },
    h(
      "div",
      { class: "section-head" },
      h("h2", null, "Projects"),
      h("span", { class: "muted" }, "Pick one to see only its issues"),
    ),
    h(
      "div",
      { class: "repo-cards" },
      [...by].map(([repo, runs]) => {
        const shipped = runs.filter((r) => r.status === "shipped").length;
        const pct = Math.round((shipped / runs.length) * 100);
        const spent = isOperator() ? `, ${money(runs.reduce((n, r) => n + (r.cost_usd || 0), 0))}` : "";
        return h(
          "button",
          {
            class: "repo-card",
            type: "button",
            "aria-pressed": String(state.repoFilter === repo),
            onclick: () => shell.setRepo(repo),
          },
          h("span", { class: "top" }, svg(REPO_ICON), short(repo), h("span", { class: "muted" }, `${pct}%`)),
          h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, pct)}%` })),
          h("span", { class: "sub" }, `${shipped} of ${plural(runs.length, "issue")} shipped${spent}`),
        );
      }),
    ),
  );
}

// Filing a task is filing an issue labelled ready, so the runner treats it like one filed by hand.
export function taskComposer() {
  const repos = state.repos.length ? state.repos : state.repo ? [state.repo] : [];
  const status = h("p", { class: "muted composer-status", role: "status" });
  return h(
    "form",
    {
      class: "new-task panel",
      "aria-label": "Start a task",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = e.target;
        const [title, ...rest] = f.task.value.trim().split("\n");
        if (!title) return f.task.focus();
        status.textContent = "Starting the task";
        try {
          const r = await post("/api/tasks", {
            title,
            body: rest.join("\n").trim(),
            type: f.type.value || null,
            repo: f.repo?.value,
          });
          f.task.value = "";
          status.textContent = `Task started as #${r.issue?.number ?? r.issue}`;
          shell.loadView();
        } catch (err) {
          status.textContent = err.message;
        }
      },
    },
    h("label", { class: "visually-hidden", for: "task" }, "What should the factory build?"),
    h("textarea", {
      class: "field-control",
      id: "task",
      name: "task",
      rows: "2",
      placeholder: "Describe what to build. The first line is the title.",
    }),
    h(
      "div",
      { class: "composer-bar" },
      h("label", { class: "visually-hidden", for: "task-type" }, "Kind of task"),
      h(
        "select",
        { class: "field-control pick", id: "task-type", name: "type" },
        TYPES.map(([v, l]) => h("option", { value: v }, l)),
      ),
      repos.length > 1
        ? [
            h("label", { class: "visually-hidden", for: "task-repo" }, "Project"),
            h(
              "select",
              { class: "field-control pick", id: "task-repo", name: "repo" },
              repos.map((r) => h("option", { value: r, selected: r === state.repoFilter }, short(r))),
            ),
          ]
        : null,
      h("button", { class: "btn btn-primary", type: "submit" }, "Start task"),
    ),
    status,
  );
}

// The headline says what the inbox needs from you, the way kaas-tasks greets you.
export function lineView() {
  return h(
    "section",
    null,
    stateOr("line", ({ rows: all }) => {
      const rows = all.filter((r) => inRepo(repoOf(r)));
      const asks = state.inbox.filter((i) => inRepo(i.repo));
      const working = rows.filter((r) => ACTIVE.has(r.run.status)).length;
      const title =
        asks.length > 1
          ? `${asks.length} things need you`
          : asks.length
            ? KIND_HEADLINE[asks[0].kind]
            : working
              ? `${working} ${working === 1 ? "run is" : "runs are"} working`
              : "All clear";
      const repos = new Set(rows.map(repoOf)).size;
      const spent = isOperator() ? `, ${money(rows.reduce((n, r) => n + (r.run.cost_usd || 0), 0))} spent` : "";
      return [
        h(
          "div",
          { class: "hero" },
          h(
            "p",
            { class: "date" },
            new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
          ),
          heading(
            title,
            rows.length ? `${plural(rows.length, "issue")} across ${plural(repos, "project")}${spent}.` : null,
            asks.length ? h("a", { class: "btn btn-primary", href: "#/inbox" }, "Open the inbox") : null,
          ),
        ),
        isOperator() ? taskComposer() : null,
        !rows.length
          ? quiet("Nothing on the line", "Start a task above, or label an issue factory:ready.")
          : h(
              "div",
              { class: "home" },
              h(
                "div",
                null,
                h(
                  "div",
                  { class: "section" },
                  h(
                    "div",
                    { class: "section-head" },
                    h("h2", null, "On the line"),
                    h(
                      "span",
                      { class: "muted" },
                      "Each bar is triage, plan, build, verify, pr, sized by how long it took",
                    ),
                    h("a", { class: "end", href: "#/runs" }, "All runs"),
                  ),
                  h("div", { class: "line", "data-multi": String(repos > 1) }, rows.map(lineRow)),
                ),
                repoCards(rows),
              ),
              activity(rows),
            ),
      ];
    }),
  );
}
