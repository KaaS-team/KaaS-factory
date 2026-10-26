// The left rail, as in a chat app's sidebar: what needs you, the tasks running and done (each with
// its risk and agent), the projects, then the pages. On a phone it is the bottom tab bar instead.

import { api, h, isOperator, repoOf, runHref, runKey, shell, short, state, svg } from "./core.js";
import { ACTIVE } from "./stations.js";
import { EXTRA_ICONS, EXTRA_NAV } from "./workflow-pages.js";

const ICONS = {
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  line: "M4 6h10M4 12h16M4 18h7",
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z",
  runs: "M4 5h16M4 10h16M4 15h16M4 20h10",
  analytics: "M5 20V10M12 20V4M19 20v-7",
  agents: "M8 8h8v8H8zM4 10v4M20 10v4M10 4h4M10 20h4",
  workflows: "M4 5h6v4H4zM14 15h6v4h-6zM7 9v3h10v3",
  ...EXTRA_ICONS,
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
};
const REPO_ICON = "M5 5h14v14H5zM9 5v14";
const CHEVRON = "M9 6l6 6-6 6";

// Inbox, Line, Board and Runs sit at the top; the rest at the foot, as on kaas-tasks.
export const NAV = [
  ["inbox", "Inbox"],
  ["line", "Line"],
  ["board", "Board"],
  ["runs", "Runs"],
  ["workflows", "Workflows"],
  ...EXTRA_NAV,
  ["analytics", "Analytics"],
  ["agents", "Fleet"],
  ["settings", "Settings"],
];
const PRIMARY = 4;
export const navFor = (me = state.me) => NAV.filter(([id]) => id !== "agents" || isOperator(me));

const RISK_TONE = { low: "ok", medium: "warn", high: "bad" };
const risks = { key: "", levels: {} };

// One request per change in the listed issues, not one per render.
async function loadRisks(rows) {
  const key = rows.map((r) => `${repoOf(r)}#${r.run.issue}`).join(",");
  if (key === risks.key) return;
  risks.key = key;
  const byRepo = new Map();
  for (const r of rows) byRepo.set(repoOf(r), [...(byRepo.get(repoOf(r)) ?? []), r.run.issue]);
  const levels = {};
  for (const [repo, issues] of byRepo) {
    const res = await api(`/api/risk?repo=${encodeURIComponent(repo)}&issues=${issues.join(",")}`).catch(() => null);
    for (const [n, level] of Object.entries(res?.levels ?? {})) levels[`${repo}#${n}`] = level;
  }
  risks.levels = levels;
  shell.render();
}

export function taskRow(row) {
  const repo = repoOf(row);
  const level = risks.levels[`${repo}#${row.run.issue}`];
  const agent = row.stages.at(-1)?.agent;
  return h(
    "a",
    { class: "rail-task", href: runHref(repo, row.run.issue), title: row.run.title },
    h("span", { class: "label" }, `#${row.run.issue} ${row.run.title}`),
    h(
      "span",
      { class: "rail-meta" },
      level && level !== "unknown"
        ? h(
            "span",
            { class: "status", "data-tone": RISK_TONE[level] },
            `${level[0].toUpperCase()}${level.slice(1)} risk`,
          )
        : null,
      agent ? h("span", null, agent) : null,
    ),
  );
}

function taskLists() {
  const rows = (state.data.line?.rows ?? []).filter((r) => !state.repoFilter || repoOf(r) === state.repoFilter);
  const running = rows.filter((r) => ACTIVE.has(r.run.status)).slice(0, 6);
  const done = rows.filter((r) => ["shipped", "cancelled", "rejected", "failed"].includes(r.run.status)).slice(0, 5);
  loadRisks([...running, ...done]);
  const list = (title, items) =>
    items.length
      ? [h("div", { class: "nav-heading" }, title), h("div", { class: "rail-list" }, items.map(taskRow))]
      : [];
  return [...list("Running", running), ...list("Done", done)];
}

export function renderNav() {
  const view = state.route.view === "task" ? "line" : state.route.view;
  const nav = navFor();
  const item = ([id, label]) =>
    h(
      "a",
      { class: "nav-item", href: `#/${id}`, "aria-current": view === id ? "page" : false },
      svg(ICONS[id]),
      h("span", { class: "label" }, label),
      id === "inbox" && state.inbox.length
        ? h("span", { class: "badge", "aria-label": `${state.inbox.length} waiting` }, String(state.inbox.length))
        : null,
    );
  const repos = state.repos.length ? state.repos : state.repo ? [state.repo] : [];
  document
    .getElementById("nav")
    .replaceChildren(
      ...nav.slice(0, PRIMARY).map(item),
      ...taskLists(),
      ...(repos.length > 1
        ? [
            h("div", { class: "nav-heading" }, "Projects"),
            ...repos.map((r) =>
              h(
                "button",
                {
                  class: "nav-item repo-item",
                  type: "button",
                  "aria-pressed": String(state.repoFilter === r),
                  title: r,
                  onclick: () => shell.setRepo(r),
                },
                svg(REPO_ICON),
                h("span", { class: "label" }, short(r)),
              ),
            ),
          ]
        : []),
      h("div", { class: "nav-spacer" }),
      ...nav.slice(PRIMARY).map(item),
    );
  const here = state.route.view === "task" ? runKey(state.route.jobID) : null;
  const crumbs = [
    h("a", { href: "#/line" }, "factory"),
    state.repoFilter
      ? h(
          "a",
          {
            href: "#/line",
            title: "Show every project",
            onclick: (e) => {
              e.preventDefault();
              shell.setRepo(state.repoFilter);
            },
          },
          short(state.repoFilter),
        )
      : null,
    here ? h("a", { href: "#/line" }, "Line") : null,
    h("span", { class: "here" }, here ? `#${here.issue}` : (NAV.find(([id]) => id === view)?.[1] ?? "Inbox")),
  ].filter(Boolean);
  document.getElementById("crumbs").replaceChildren(...crumbs.flatMap((c, i) => (i ? [svg(CHEVRON), c] : [c])));
}
