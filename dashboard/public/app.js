// The factory cockpit. Vanilla ES modules, no build step. Every string from
// the server goes in as a text node (see h() in lib/core.js); no markup is ever built from it.
// This file is the shell: routing, loading and the render loop. Each view lives in lib/view-*.js.

import { api, h, heading, plural, post, quiet, repoQuery, shell, short, state, stateOr } from "/lib/core.js";
import { renderNav } from "/lib/rail.js";
import { readRelay } from "/lib/relay-follow.js";
import { followRelay, startRemote } from "/lib/remote.js";
import { routeFromHash } from "/lib/routes.js";
import { createStatusLoader } from "/lib/status-loader.js";
import { analyticsView } from "/lib/view-analytics.js";
import { boardView } from "/lib/view-board.js";
import { agentsView } from "/lib/view-fleet.js";
import { inboxView, selectItem } from "/lib/view-inbox.js";
import { lineView } from "/lib/view-line.js";
import { live, pollLive, runView } from "/lib/view-run.js";
import { runsView } from "/lib/view-runs.js";
import { settingsView } from "/lib/view-settings.js";
import { workflowsView } from "/lib/view-workflows.js";
import { EXTRA_LOADERS, extraViews } from "/lib/workflow-pages.js";

const VIEWS = {
  inbox: inboxView,
  line: lineView,
  board: boardView,
  runs: runsView,
  task: runView,
  workflows: workflowsView,
  ...extraViews({ h, heading, stateOr, quiet, post }),
  analytics: analyticsView,
  agents: agentsView,
  settings: settingsView,
};
const LOADERS = {
  inbox: ["analytics", "/api/analytics"],
  line: ["line", "/api/line"],
  board: ["board", () => `/api/board${repoQuery()}`],
  runs: ["runs", "/api/runs"],
  task: ["line", "/api/line"],
  workflows: ["workflows", "/api/workflows"],
  ...EXTRA_LOADERS,
  analytics: ["analytics", "/api/analytics"],
  agents: ["agents", "/api/agents"],
  settings: ["settings", "/api/settings"],
};

let stopRelay = () => {};
function startFollowing() {
  stopRelay();
  const cfg = readRelay(localStorage);
  stopRelay = cfg
    ? followRelay(cfg, (p) => {
        state.relay = p;
        // The first line can land after the dashboard already failed, so its error counts too.
        if (state.offline || state.error.inbox) {
          state.offline = true;
          state.inbox = p.items;
          render();
        }
      })
    : () => {};
}

function setRepo(repo) {
  state.repoFilter = state.repoFilter === repo ? "" : repo;
  loadInbox().then(render);
  loadView();
}

// The toast repeats the action's own word ("Approve plan" comes back as "Plan approved").
function renderToast() {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = state.toast;
  el.hidden = !state.toast;
  if (state.toast) {
    clearTimeout(renderToast.timer);
    renderToast.timer = setTimeout(() => {
      state.toast = "";
      el.hidden = true;
    }, 5000);
  }
}

// The feed follows the newest card unless the reader scrolled up to look at an older one.
function render() {
  const main = document.getElementById("view");
  const focused = document.activeElement?.id === "composer" ? document.getElementById("composer").value : null;
  const feed = document.getElementById("feed");
  const follow = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const top = feed?.scrollTop ?? 0;
  main.dataset.view = state.route.view;
  main.replaceChildren(h("div", { class: "page" }, (VIEWS[state.route.view] || inboxView)()));
  const next = document.getElementById("feed");
  if (next) next.scrollTop = follow ? next.scrollHeight : top;
  if (focused != null) {
    const c = document.getElementById("composer");
    if (c) {
      c.value = focused;
      c.focus();
    }
  }
  renderNav();
  renderToast();
}

function go(view, issue, repo = state.repo) {
  state.selected = issue ? { repo, issue } : null;
  if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
  else render();
  if (issue) {
    const item = state.inbox.find((i) => i.issue === issue && i.repo === repo);
    if (item) selectItem(item);
  }
}

function showLogin() {
  document.getElementById("view").replaceChildren(
    h(
      "form",
      {
        class: "login",
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await post("/api/session", { token: e.target.token.value });
            location.reload();
          } catch {
            e.target.querySelector(".error").textContent = "That token was not accepted.";
          }
        },
      },
      h("h1", null, "Sign in"),
      h("label", { class: "muted", for: "token" }, "Dashboard token"),
      h("input", {
        class: "field-control",
        id: "token",
        name: "token",
        type: "password",
        autocomplete: "current-password",
      }),
      h("p", { class: "error", role: "alert" }),
      h("button", { class: "btn btn-primary", type: "submit" }, "Sign in"),
    ),
  );
}

async function loadInbox() {
  try {
    const q = state.repoFilter ? `?repo=${encodeURIComponent(state.repoFilter)}` : "";
    const r = await api(`/api/inbox${q}`);
    state.inbox = r.items;
    state.repo = r.repo;
    state.repos = r.repos || [];
    state.error.inbox = null;
    state.offline = false;
  } catch (e) {
    state.error.inbox = e.message;
    if (state.relay) {
      state.inbox = state.relay.items;
      state.offline = true;
    }
  }
  document.getElementById("repo-label").textContent =
    state.repos.length > 1 ? plural(state.repos.length, "project") : short(state.repo);
  renderNav();
}

// A newer request wins, so a slow response can never overwrite a fresher one.
const loaders = {};
function load([name, path]) {
  loaders[name] ||= createStatusLoader({
    request: () => api(typeof path === "function" ? path() : path),
    apply: (r) => {
      if (r.kind === "success") {
        state.data[name] = r.status;
        state.error[name] = null;
      } else state.error[name] = r.message;
      render();
    },
  });
  return loaders[name].refresh();
}
// The rail lists running and done tasks on every page, so the line loads on every page too.
function loadView() {
  const spec = LOADERS[state.route.view];
  return Promise.all([spec ? load(spec) : null, spec?.[0] === "line" ? null : load(LOADERS.line)]);
}

function onRoute() {
  state.route = routeFromHash(location.hash);
  clearInterval(live.timer);
  if (state.route.view === "task") {
    live.timer = setInterval(pollLive, 1000);
    pollLive();
  }
  render();
  loadView();
}

Object.assign(shell, { render, go, loadInbox, loadView, setRepo, showLogin, startFollowing });

// Installable as an app; registration fails over plain http off localhost, and the page works the same.
navigator.serviceWorker?.register("/sw.js").catch(() => {});
window.addEventListener("hashchange", onRoute);
api("/api/me")
  .then((me) => (state.me = me))
  .catch(() => {})
  .finally(onRoute);
startFollowing();
loadInbox().then(render);
startRemote(() => loadInbox().then(render));
setInterval(() => {
  loadInbox().then(() => state.route.view === "inbox" && !document.activeElement?.closest?.("#composer") && render());
  loadView();
}, 5000);
