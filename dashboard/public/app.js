// The factory cockpit. Vanilla ES modules, no build step. Every string from
// the server goes in as a text node (see h()); no markup is ever built from it.

import { routeFromHash } from "/lib/routes.js";
import { createStatusLoader } from "/lib/status-loader.js";
import { formatElapsed } from "/lib/run-metrics.js";
import { ACTIVE, stationStates, WAITING } from "/lib/stations.js";
import { markdownText, renderMarkdown } from "/lib/markdown.js";
import { feedCard, proofPanel } from "/lib/run-page.js";

const ACTION_LABEL = {
  approve: "Approve plan",
  revise: "Request changes",
  answer: "Send answer",
  retry: "Retry",
  cancel: "Cancel run",
};
const REVIEW_KINDS = new Set(["review-pr", "merge-dry-run"]);
const KIND_HEADLINE = {
  "approve-plan": "A plan is waiting for your approval",
  "answer-question": "The factory has a question for you",
  "review-pr": "A pull request is ready for your review",
  "merge-dry-run": "A pull request is ready to merge",
  parked: "A run needs a human",
  failed: "A run failed",
  budget: "A run hit its budget",
};
const KIND_LABEL = {
  "approve-plan": "Plan to approve",
  "answer-question": "Question for you",
  "review-pr": "Pull request to review",
  "merge-dry-run": "Ready to merge",
  parked: "Needs a human",
  failed: "Failed",
  budget: "Over budget",
};
const ICONS = {
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  line: "M4 6h10M4 12h16M4 18h7",
  runs: "M4 5h16M4 10h16M4 15h16M4 20h10",
  analytics: "M5 20V10M12 20V4M19 20v-7",
  agents: "M8 8h8v8H8zM4 10v4M20 10v4M10 4h4M10 20h4",
  workflows: "M4 5h6v4H4zM14 15h6v4h-6zM7 9v3h10v3",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
};
const NAV = [
  ["inbox", "Inbox"],
  ["line", "Line"],
  ["runs", "Runs"],
  ["workflows", "Workflows"],
  ["analytics", "Analytics"],
  ["agents", "Agents"],
  ["settings", "Settings"],
];
const PRIMARY = 3; // Inbox, Line and Runs sit at the top; the rest at the foot, as on kaas-tasks
const REPO_ICON = "M5 5h14v14H5zM9 5v14";
const CHEVRON = "M9 6l6 6-6 6";

const state = {
  route: routeFromHash(location.hash),
  inbox: [],
  repo: "",
  repos: [],
  repoFilter: "",
  selected: null,
  thread: null,
  review: null,
  filter: "all",
  data: {},
  error: {},
};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true && !/^(data|aria)-/.test(k) ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const svg = (path) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  s.append(p);
  return s;
};

const svgEl = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
// kaas-tasks' status icons: a ring while queued, half filled while working, a disc once it means something.
const GLYPHS = {
  queued: [["circle", { class: "ring", cx: 12, cy: 12, r: 7, "stroke-dasharray": "2.6 2.4" }]],
  live: [
    ["circle", { class: "ring", cx: 12, cy: 12, r: 7 }],
    ["path", { class: "fill", d: "M12 7.5a4.5 4.5 0 0 1 0 9z" }],
  ],
  waiting: [
    ["circle", { class: "disc", cx: 12, cy: 12, r: 8 }],
    ["path", { class: "mark", d: "M12 8.5v4M12 15.6v.01" }],
  ],
  shipped: [
    ["circle", { class: "disc", cx: 12, cy: 12, r: 8 }],
    ["path", { class: "mark", d: "M8.6 12.2l2.3 2.3 4.6-4.8" }],
  ],
  failed: [
    ["circle", { class: "disc", cx: 12, cy: 12, r: 8 }],
    ["path", { class: "mark", d: "M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8" }],
  ],
  quiet: [
    ["circle", { class: "ring", cx: 12, cy: 12, r: 7 }],
    ["path", { class: "mark", d: "M8 16l8-8" }],
  ],
};
const glyphKind = (status) =>
  status === "shipped"
    ? "shipped"
    : ["failed", "rejected"].includes(status)
      ? "failed"
      : WAITING.has(status)
        ? "waiting"
        : ACTIVE.has(status)
          ? "live"
          : status === "queued"
            ? "queued"
            : "quiet";
function glyph(kind, label) {
  const s = svgEl("svg", {
    class: "glyph",
    viewBox: "0 0 24 24",
    "data-s": kind,
    role: "img",
    "aria-label": label || kind,
  });
  s.append(...GLYPHS[kind].map(([tag, attrs]) => svgEl(tag, attrs)));
  return s;
}
const repoOf = (row) => row.repo ?? state.repo;
const inRepo = (repo) => !state.repoFilter || repo === state.repoFilter;
const short = (repo) => (repo || "").split("/").pop();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const initials = (name) => (name === "factory" ? "F" : name.slice(0, 2).toUpperCase());

const money = (n) => `$${(n || 0).toFixed(2)}`;
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
function age(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}
const tone = (status) =>
  status === "shipped"
    ? "ok"
    : ["failed", "rejected"].includes(status)
      ? "bad"
      : WAITING.has(status)
        ? "warn"
        : ACTIVE.has(status)
          ? "live"
          : "";
const statusText = (s) => s.replace(/-/g, " ");
const cleanBody = (body) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

async function api(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401) {
    showLogin();
    throw new Error("Sign in to continue");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---- states shared by every view ---- */
const quiet = (title, hint, ...extra) =>
  h(
    "div",
    { class: "quiet-state" },
    h("div", { class: "quiet-state-mark", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("strong", null, title),
    h("span", null, hint),
    ...extra,
  );
const heading = (title, lede, ...extra) =>
  h(
    "div",
    { class: "page-heading" },
    h("div", null, h("h1", null, title), lede && h("p", { class: "lede" }, lede)),
    ...extra,
  );
const stateOr = (name, ready) => {
  if (state.error[name]) return quiet("Could not load this view", state.error[name]);
  if (!state.data[name]) return quiet("Loading", "Reading the factory's state.");
  return ready(state.data[name]);
};

/* ---- Line: the home page ---- */
function stationsFor(row) {
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
        title: `${name}${ms ? ` · ${formatElapsed(ms)}` : ""}`,
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
      onclick: () => (needs ? go("inbox", run.issue, repo) : (location.hash = runHref(repo, run.issue))),
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
    h("span", { class: "line-cost" }, money(run.cost_usd)),
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
            h("p", { class: "sub" }, `#${row.run.issue} ${row.run.title} · ${age(row.run.updated_at)} ago`),
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
      h("h2", null, "Repos"),
      h("span", { class: "muted" }, "Pick one to see only its issues"),
    ),
    h(
      "div",
      { class: "repo-cards" },
      [...by].map(([repo, runs]) => {
        const shipped = runs.filter((r) => r.status === "shipped").length;
        const pct = Math.round((shipped / runs.length) * 100);
        return h(
          "button",
          {
            class: "repo-card",
            type: "button",
            "aria-pressed": String(state.repoFilter === repo),
            onclick: () => setRepo(repo),
          },
          h("span", { class: "top" }, svg(REPO_ICON), short(repo), h("span", { class: "muted" }, `${pct}%`)),
          h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, pct)}%` })),
          h(
            "span",
            { class: "sub" },
            `${shipped} of ${plural(runs.length, "issue")} shipped · ${money(runs.reduce((n, r) => n + (r.cost_usd || 0), 0))}`,
          ),
        );
      }),
    ),
  );
}

// The headline says what the inbox needs from you, the way kaas-tasks greets you.
function lineView() {
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
      const spent = money(rows.reduce((n, r) => n + (r.run.cost_usd || 0), 0));
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
            rows.length ? `${plural(rows.length, "issue")} across ${plural(repos, "repo")}, ${spent} spent.` : null,
            asks.length ? h("a", { class: "btn btn-primary", href: "#/inbox" }, "Open the inbox") : null,
          ),
        ),
        !rows.length
          ? quiet("Nothing on the line", "Label an issue factory:ready to start a run.")
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

/* ---- Inbox ---- */
function isSelected(i) {
  return state.selected != null && state.selected.repo === i.repo && state.selected.issue === i.issue;
}

async function selectItem(item) {
  state.selected = { repo: item.repo, issue: item.issue };
  state.thread = null;
  state.review = null;
  render();
  const q = `?repo=${encodeURIComponent(item.repo)}`;
  const wantsReview = REVIEW_KINDS.has(item.kind);
  const [thread, review] = await Promise.allSettled([
    api(`/api/issues/${item.issue}/thread${q}`),
    wantsReview ? api(`/api/issues/${item.issue}/review${q}`) : Promise.resolve(null),
  ]);
  state.thread = thread.status === "fulfilled" ? thread.value.issue : { error: thread.reason.message };
  if (wantsReview) state.review = review.status === "fulfilled" ? review.value : { error: review.reason.message };
  render();
}

async function actOn(item, action, text) {
  if (action === "cancel" && !confirm(`Cancel the run for #${item.issue}? This closes the issue.`)) return;
  try {
    await post(`/api/inbox/${item.issue}/act`, { action, text, repo: item.repo });
    state.selected = null;
    state.review = null;
    await Promise.all([loadInbox(), loadView()]);
  } catch (e) {
    alert(e.message);
  }
  render();
}

async function mergeApprove(item) {
  try {
    const r = await post(`/api/issues/${item.issue}/merge`, { repo: item.repo });
    if (r.decision.outcome !== "merge") {
      alert(`Not merged:\n${r.decision.refusals.map((x) => `- ${x.detail}`).join("\n")}`);
      return;
    }
    state.selected = null;
    state.review = null;
    await Promise.all([loadInbox(), loadView()]);
  } catch (e) {
    alert(e.message);
  }
  render();
}

function actionLabel(item, a) {
  return REVIEW_KINDS.has(item.kind) && a === "cancel" ? "Close" : ACTION_LABEL[a];
}

function reviewPanel() {
  const r = state.review;
  if (!r) return quiet("Loading", "Reading the pull request.");
  if (r.error) return quiet("Could not load the review", r.error);
  const ciTone = r.ci.status === "passed" ? "ok" : r.ci.status === "failed" ? "bad" : "warn";
  return h(
    "div",
    { class: "review" },
    h(
      "dl",
      { class: "kv" },
      h("dt", null, "Pull request"),
      h("dd", null, h("a", { href: r.pr.url, target: "_blank", rel: "noreferrer" }, `#${r.pr.number}`)),
      h("dt", null, "CI"),
      h("dd", null, h("span", { class: "status", "data-tone": ciTone }, statusText(r.ci.status))),
      r.gate ? [h("dt", null, "Gate"), h("dd", null, `${r.gate.status} · ${r.gate.line}`)] : null,
      r.verify?.result ? [h("dt", null, "Verify"), h("dd", null, r.verify.result)] : null,
    ),
    r.verify?.findings?.length
      ? h(
          "div",
          null,
          h("h3", null, "Verify findings"),
          h(
            "ul",
            { class: "plain-list" },
            r.verify.findings.map((f) => h("li", null, typeof f === "string" ? f : `${f.severity}: ${f.what}`)),
          ),
        )
      : null,
    r.stages.length
      ? h(
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
                ["Stage", "Agent", "Model", "Cost"].map((c, i) => h("th", { class: i === 3 ? "num" : "" }, c)),
              ),
            ),
            h(
              "tbody",
              null,
              r.stages.map((s) =>
                h(
                  "tr",
                  null,
                  h("td", null, s.stage),
                  h("td", null, s.agent),
                  h("td", null, s.model || "default"),
                  h("td", { class: "num" }, s.usage_complete === 0 ? "Not reported" : money(s.cost_usd)),
                ),
              ),
            ),
          ),
        )
      : null,
    h("h3", { style: "margin-top:1rem" }, "Diff"),
    h(
      "pre",
      { class: "log diff" },
      r.diff
        ? r.diff.split("\n").map((l) =>
            h(
              "span",
              {
                class: /^\+(?!\+\+)/.test(l)
                  ? "diff-add"
                  : /^-(?!--)/.test(l)
                    ? "diff-del"
                    : /^@@/.test(l)
                      ? "diff-hunk"
                      : "",
              },
              l,
            ),
          )
        : "No diff available.",
    ),
  );
}

function conversation(item) {
  const t = state.thread;
  const body = !t
    ? quiet("Loading", "Reading the issue thread.")
    : t.error
      ? quiet("Could not load the thread", t.error)
      : h(
          "div",
          { class: "thread" },
          [
            { author: "issue", body: t.body, bot: false },
            ...(t.comments || [])
              .filter((c) => !c.body.includes("<!-- factory:spend"))
              .map((c) => ({ author: c.author, body: c.body, bot: c.body.includes("<!-- factory:") })),
          ]
            .filter((m) => cleanBody(m.body))
            .map((m) =>
              h(
                "div",
                { class: `msg${m.bot ? " bot" : ""}` },
                h(
                  "header",
                  null,
                  h(
                    "span",
                    { class: "avatar", "data-bot": m.bot, "aria-hidden": "true" },
                    initials(m.bot ? "factory" : m.author),
                  ),
                  m.bot ? "factory" : m.author,
                ),
                renderMarkdown(m.body, h),
              ),
            ),
        );
  const needsText = item.actions.filter((a) => a === "revise" || a === "answer");
  const box = needsText.length
    ? h("textarea", {
        class: "field-control",
        id: "composer",
        rows: "3",
        placeholder: item.kind === "answer-question" ? "Your answer" : "What should change?",
        "aria-label": "Your reply",
      })
    : null;
  const isReview = REVIEW_KINDS.has(item.kind);
  return h(
    "div",
    { class: "panel" },
    h(
      "div",
      { class: "panel-pad" },
      h("h2", null, `#${item.issue} ${item.title}`),
      h(
        "span",
        { class: "muted" },
        `${item.repo} · ${item.label.replace("factory:", "").replace(/-/g, " ")} · waiting ${age(item.waitingSince)}`,
      ),
    ),
    isReview ? h("div", { class: "panel-pad" }, reviewPanel()) : null,
    body,
    h(
      "div",
      { class: "composer" },
      box,
      h(
        "div",
        { class: "actions" },
        isReview
          ? h(
              "button",
              { class: "btn btn-primary", type: "button", onclick: () => mergeApprove(item) },
              "Approve and merge",
            )
          : null,
        item.actions.map((a) =>
          h(
            "button",
            {
              class: `btn${a === "approve" || a === "answer" ? " btn-primary" : a === "cancel" ? " btn-danger" : ""}`,
              type: "button",
              onclick: () => {
                const text = box ? box.value : "";
                if ((a === "revise" || a === "answer") && !text.trim()) {
                  box.focus();
                  return;
                }
                actOn(item, a, text);
              },
            },
            actionLabel(item, a),
          ),
        ),
      ),
    ),
  );
}

function inboxView() {
  const items = state.inbox.filter((i) => inRepo(i.repo));
  const multiRepo = state.repos.length > 1;
  const item = items.find(isSelected);
  return h(
    "section",
    null,
    heading("Inbox", "Everything the factory is waiting on you for."),
    !items.length
      ? quiet("Nothing is waiting on you", "The factory will list plans to approve and questions to answer here.")
      : h(
          "div",
          { class: "split", "data-open": String(Boolean(item)) },
          h(
            "div",
            { class: "list-col" },
            h(
              "div",
              { class: "list" },
              items.map((i) =>
                h(
                  "button",
                  {
                    class: "list-item",
                    type: "button",
                    "aria-current": String(isSelected(i)),
                    onclick: () => selectItem(i),
                  },
                  glyph(["failed", "budget"].includes(i.kind) ? "failed" : "waiting", KIND_LABEL[i.kind]),
                  h(
                    "span",
                    { class: "li-main" },
                    h("strong", null, `#${i.issue} ${i.title}`),
                    h(
                      "span",
                      { class: "li-sub" },
                      [KIND_LABEL[i.kind], multiRepo ? short(i.repo) : null].filter(Boolean).join(" · "),
                    ),
                    h("span", { class: "li-ask" }, markdownText(i.ask).slice(0, 140)),
                  ),
                  h("span", { class: "li-time" }, age(i.waitingSince)),
                ),
              ),
            ),
          ),
          h(
            "div",
            { class: "detail-col" },
            item
              ? [
                  h(
                    "button",
                    {
                      class: "btn back",
                      type: "button",
                      onclick: () => {
                        state.selected = null;
                        state.review = null;
                        render();
                      },
                    },
                    "Back to inbox",
                  ),
                  conversation(item),
                ]
              : h("div", { class: "empty-detail" }, svg(ICONS.inbox), h("p", null, "Select an item to read it")),
          ),
        ),
  );
}

/* ---- Runs ---- */
const FILTERS = [
  ["all", "All", () => true],
  ["active", "Active", (r) => ACTIVE.has(r.status)],
  ["needs", "Needs you", (r) => WAITING.has(r.status)],
  ["done", "Finished", (r) => ["shipped", "cancelled", "rejected"].includes(r.status)],
];

function runsView() {
  return h(
    "section",
    null,
    heading("Runs", "Every run the factory has started, newest first."),
    stateOr("runs", ({ runs }) => {
      const pick = FILTERS.find((f) => f[0] === state.filter)[2];
      runs = runs.filter((r) => inRepo(r.repo ?? state.repo));
      const rows = runs.filter(pick);
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
                  render();
                },
              },
              `${label} ${runs.filter(fn).length}`,
            ),
          ),
        ),
        rows.length
          ? h(
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
                    ["Issue", "Status", "Stage", "Cost", "Updated"].map((c, i) =>
                      h("th", { class: i >= 3 ? "num" : "" }, c),
                    ),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  rows.map((r) =>
                    h(
                      "tr",
                      {
                        "data-href": r.issue,
                        tabindex: "0",
                        onclick: () => (location.hash = runHref(r.repo, r.issue)),
                        onkeydown: (e) => e.key === "Enter" && (location.hash = runHref(r.repo, r.issue)),
                      },
                      h(
                        "td",
                        null,
                        `#${r.issue} ${r.title}`,
                        state.repos.length > 1 ? h("div", { class: "muted" }, short(r.repo ?? state.repo)) : null,
                      ),
                      h("td", null, h("span", { class: "status", "data-tone": tone(r.status) }, statusText(r.status))),
                      h("td", null, r.stage),
                      h("td", { class: "num" }, money(r.cost_usd)),
                      h("td", { class: "num" }, age(r.updated_at)),
                    ),
                  ),
                ),
              ),
            )
          : quiet(
              "No runs match",
              state.filter === "all" ? "Label an issue factory:ready to start one." : "Try another filter.",
            ),
      );
    }),
  );
}

/* ---- One run: the agent's activity and the proof, on one page ---- */
// #/runs/<owner>/<name>/<issue>, or #/runs/<issue> for the configured repo.
const runKey = (jobID) => {
  const m = /^(?:(.+)\/)?(\d+)$/.exec(jobID);
  return m ? { repo: m[1] || state.repo, issue: Number(m[2]) } : null;
};
const runHref = (repo, issue) => `#/runs/${repo ? `${repo}/` : ""}${issue}`;
const live = { key: "", items: [], next: 0, proof: null, files: null, preview: null, timer: 0 };

async function pollLive() {
  const at = runKey(state.route.jobID);
  if (state.route.view !== "task" || !at) return;
  const key = `${at.repo}#${at.issue}`;
  if (live.key !== key) Object.assign(live, { key, items: [], next: 0, proof: null, files: null, preview: null });
  const q = `repo=${encodeURIComponent(at.repo || "")}`;
  const [feed, proof] = await Promise.allSettled([
    api(`/api/issues/${at.issue}/live?${q}&from=${live.next}`),
    api(`/api/issues/${at.issue}/proof?${q}`),
  ]);
  if (live.key !== key) return; // the page moved on while these loaded
  let changed = false;
  if (feed.value) {
    if (feed.value.next < live.next) live.items = [];
    if (feed.value.items.length || feed.value.next < live.next) changed = true;
    live.items.push(...feed.value.items);
    live.next = feed.value.next;
  }
  if (proof.value && JSON.stringify(proof.value) !== JSON.stringify(live.proof)) {
    live.proof = proof.value;
    changed = true;
  }
  if (changed) render();
}

async function runFiles(issue) {
  live.files = (await api(`/api/issues/${issue}/artifacts`).catch(() => ({ files: [] }))).files;
  render();
}

async function preview(issue, name) {
  const res = await fetch(`/api/issues/${issue}/artifacts?file=${encodeURIComponent(name)}`);
  live.preview = {
    name,
    text: res.ok ? await res.text() : "Could not read this file.",
    truncated: res.headers.get("x-artifact-truncated") === "true",
  };
  render();
}

function runView() {
  const at = runKey(state.route.jobID);
  if (!at) return h("section", null, quiet("No such run", "Pick a run from the Line."));
  const row = state.data.line?.rows.find((r) => r.run.issue === at.issue && (r.repo ?? state.repo) === at.repo);
  const run = row?.run;
  const stations = row ? stationsFor(row) : [];
  const sub = [at.repo, run && `started ${age(run.started_at)} ago`, run && money(run.cost_usd)]
    .filter(Boolean)
    .join(" · ");
  return h(
    "section",
    { class: "run-page" },
    heading(
      `#${at.issue} ${run?.title ?? ""}`.trim(),
      sub,
      run
        ? h(
            "span",
            { class: "status", "data-tone": tone(run.status) },
            WAITING.has(run.status) ? "Waiting on you" : statusText(run.status),
          )
        : null,
    ),
    row
      ? h(
          "div",
          { class: "run-stations" },
          h(
            "div",
            { class: "stations" },
            stations.map((s) => s.node),
          ),
          h(
            "div",
            { class: "station-names" },
            stations.map((s) => h("span", { style: `flex-grow:${s.grow}` }, s.name)),
          ),
        )
      : null,
    h(
      "div",
      { class: "run-grid" },
      h(
        "div",
        { class: "panel feed-panel" },
        h("h2", { class: "panel-pad" }, "What the agent is doing"),
        h(
          "div",
          { class: "feed", id: "feed" },
          live.items.length
            ? live.items.map((i) => feedCard(i, h))
            : quiet("Nothing yet", "The agent's reads, edits and test runs show here as it works."),
        ),
      ),
      h(
        "aside",
        { class: "panel panel-pad proof-col" },
        h("h2", null, "Proof"),
        proofPanel(live.proof, h),
        run?.pr_url
          ? h(
              "p",
              { class: "pr-link" },
              h("a", { href: run.pr_url, target: "_blank", rel: "noreferrer" }, "Open the pull request"),
            )
          : null,
      ),
    ),
    h(
      "details",
      { class: "run-files", ontoggle: (e) => e.target.open && !live.files && runFiles(at.issue) },
      h("summary", null, "Files from the run"),
      !live.files
        ? h("p", { class: "muted" }, "Loading")
        : live.files.length
          ? h(
              "div",
              { class: "actions" },
              live.files.map((f) =>
                h(
                  "button",
                  { class: "btn", type: "button", onclick: () => preview(at.issue, f.name) },
                  `${f.name} (${compact(f.size)}B)`,
                ),
              ),
            )
          : h("p", { class: "muted" }, "This run left no files on this machine."),
      live.preview && [
        h(
          "p",
          { class: "muted" },
          `${live.preview.name}${live.preview.truncated ? " (first 1 MiB)" : ""} `,
          h(
            "a",
            { href: `/api/issues/${at.issue}/artifacts?file=${encodeURIComponent(live.preview.name)}&download=1` },
            "Download",
          ),
        ),
        h("pre", { class: "log" }, live.preview.text),
      ],
    ),
  );
}

/* ---- Analytics ---- */
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
            `${money(b.costUsd)} · ${b.attempts} ${b.attempts === 1 ? "attempt" : "attempts"} · ${formatElapsed(b.avgDurationMs)} avg`,
          ),
        ),
      ),
    ),
  );
}

function analyticsView() {
  return h(
    "section",
    null,
    heading("Analytics", "What the factory delivers, and what it costs."),
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
                [money(a.spend7dUsd), "Spent in 7 days"],
                [money(a.spend30dUsd), "Spent in 30 days"],
                ...(a.savings.runs
                  ? [[money(a.savings.savedUsd), `Saved by model routing, ${a.savings.runs} priced attempts`]]
                  : []),
              ].map(([v, l]) =>
                h("div", { class: "kpi" }, h("span", { class: "value" }, v), h("span", { class: "label" }, l)),
              ),
            ),
            bars("Cost by stage", a.byStage),
            bars("Cost by agent", a.byAgent),
            bars("Cost by model", a.byModel),
          ),
    ),
  );
}

/* ---- Agents ---- */
function agentsView() {
  return h(
    "section",
    null,
    heading("Agents", "The coding agents the factory can run, and which stages each one serves."),
    stateOr("agents", (a) =>
      !a.agents.length
        ? quiet("No agents configured", "Add one under agents in .factory/config.json.")
        : h(
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
                  ["Agent", "Command", "Installed", "Pinned version", "Verified live", "Doctor", "Stages"].map((c) =>
                    h("th", null, c),
                  ),
                ),
              ),
              h(
                "tbody",
                null,
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
          ),
    ),
  );
}

/* ---- Workflows: factory harness inventory and validate ---- */
const ROUTED = (w) =>
  w.routedTypes.includes("*")
    ? "The repo's workflow"
    : w.routedTypes.length
      ? `Issue types: ${w.routedTypes.join(", ")}`
      : "Not routed";

function workflowsView() {
  return h(
    "section",
    null,
    heading(
      "Workflows",
      "Every workflow this repo can run, the issue types routed to each, and whether they all load.",
    ),
    stateOr("workflows", (d) =>
      !d.available
        ? quiet("No repo to read", d.reason)
        : h(
            "div",
            null,
            h(
              "div",
              { class: "panel panel-pad harness" },
              h("h2", null, "Harness check"),
              d.problems.length
                ? h(
                    "ul",
                    { class: "plain-list" },
                    d.problems.map((p) => h("li", null, h("span", { class: "status", "data-tone": "bad" }, p))),
                  )
                : h(
                    "span",
                    { class: "status", "data-tone": "ok" },
                    "Every workflow loads, and every route names one that exists.",
                  ),
            ),
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
                    ["Workflow", "From", "Runs for", "Steps", "Schedule"].map((c) => h("th", null, c)),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  d.workflows.map((w) =>
                    h(
                      "tr",
                      null,
                      h(
                        "td",
                        null,
                        h("span", { class: "status", "data-tone": w.problems.length ? "bad" : "ok" }, w.name),
                        w.problems.length ? h("div", { class: "muted" }, w.problems.join("; ")) : null,
                      ),
                      h("td", null, w.source === "repo" ? ".factory/workflows" : "Runner"),
                      h("td", null, ROUTED(w)),
                      h(
                        "td",
                        null,
                        h(
                          "span",
                          { class: "steps" },
                          w.steps.map((st) =>
                            h(
                              "code",
                              { title: st.runtime ? `runs on ${st.runtime}` : st.uses },
                              st.uses === st.id ? st.id : `${st.id} (${st.uses})`,
                            ),
                          ),
                        ),
                      ),
                      h(
                        "td",
                        null,
                        w.cron.length || (w.events ?? []).length
                          ? [
                              ...w.cron.map((c) => h("div", null, `${c.schedule} ${c.tz}: ${c.title}`)),
                              ...(w.events ?? []).map((t) => h("div", null, `On ${t}`)),
                            ]
                          : "On issue labels",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

/* ---- Settings: runtimes and leases ---- */
function settingsView() {
  return h(
    "section",
    null,
    heading("Settings", "Where gates and checks run, and which worker holds each issue right now."),
    stateOr("settings", (d) =>
      !d.available
        ? quiet("No repo to read", d.reason)
        : h(
            "div",
            null,
            h(
              "dl",
              { class: "kv" },
              h("dt", null, "Slots"),
              h("dd", null, String(d.slots)),
              h("dt", null, "Daily cap"),
              h("dd", null, d.dailyUsd == null ? "None set" : money(d.dailyUsd)),
            ),
            h("h2", null, "Runtimes"),
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
                    ["Runtime", "Kind", "Target", "Used by"].map((c) => h("th", null, c)),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  d.runtimes.map((r) =>
                    h(
                      "tr",
                      null,
                      h(
                        "td",
                        null,
                        h("span", { class: "status", "data-tone": r.usedBy.length ? "live" : "" }, r.name),
                        r.builtin ? h("span", { class: "muted" }, " built in") : null,
                      ),
                      h("td", null, r.kind),
                      h("td", null, h("code", null, r.target)),
                      h("td", null, r.usedBy.length ? r.usedBy.join(", ") : "Nothing in this repo"),
                    ),
                  ),
                ),
              ),
            ),
            h("h2", { class: "section-gap" }, "Issue leases"),
            d.leasesError
              ? h("p", { class: "error" }, `Could not read the lease refs: ${d.leasesError}`)
              : !d.leases.length
                ? quiet("No leases", "A worker takes refs/factory/lease/<issue> while it runs an issue.")
                : h(
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
                          ["Issue", "Holder", "State"].map((c) => h("th", null, c)),
                        ),
                      ),
                      h(
                        "tbody",
                        null,
                        d.leases.map((l) =>
                          h(
                            "tr",
                            null,
                            h("td", null, l.key),
                            h("td", null, l.holder),
                            h(
                              "td",
                              null,
                              h(
                                "span",
                                { class: "status", "data-tone": l.live ? "live" : "" },
                                l.live
                                  ? `Held, expires in ${Math.max(1, Math.round((l.expiresAt - Date.now()) / 1000))}s`
                                  : l.expiresAt === 0
                                    ? "Released"
                                    : "Expired",
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
          ),
    ),
  );
}

/* ---- shell ---- */
const VIEWS = {
  inbox: inboxView,
  line: lineView,
  runs: runsView,
  task: runView,
  workflows: workflowsView,
  analytics: analyticsView,
  agents: agentsView,
  settings: settingsView,
};
const LOADERS = {
  line: ["line", "/api/line"],
  runs: ["runs", "/api/runs"],
  task: ["line", "/api/line"],
  workflows: ["workflows", "/api/workflows"],
  analytics: ["analytics", "/api/analytics"],
  agents: ["agents", "/api/agents"],
  settings: ["settings", "/api/settings"],
};

function setRepo(repo) {
  state.repoFilter = state.repoFilter === repo ? "" : repo;
  loadInbox().then(render);
}

function allRepos() {
  return state.repos.length ? state.repos : state.repo ? [state.repo] : [];
}

function renderNav() {
  const view = state.route.view === "task" ? "line" : state.route.view;
  const item = ([id, label]) =>
    h(
      "a",
      { class: "nav-item", href: `#/${id}`, "aria-current": view === id ? "page" : false },
      svg(ICONS[id]),
      h("span", { class: "label" }, label),
      id === "inbox" && state.inbox.length ? h("span", { class: "badge" }, String(state.inbox.length)) : null,
    );
  const onLine = (repo) => state.data.line?.rows.filter((r) => repoOf(r) === repo).length;
  const repos = allRepos();
  document.getElementById("nav").replaceChildren(
    ...NAV.slice(0, PRIMARY).map(item),
    ...(repos.length > 1
      ? [
          h("div", { class: "nav-heading" }, "Repos"),
          ...repos.map((r) =>
            h(
              "button",
              {
                class: "nav-item repo-item",
                type: "button",
                "aria-pressed": String(state.repoFilter === r),
                title: r,
                onclick: () => setRepo(r),
              },
              svg(REPO_ICON),
              h("span", { class: "label" }, short(r)),
              onLine(r) ? h("span", { class: "count" }, String(onLine(r))) : null,
            ),
          ),
        ]
      : []),
    h("div", { class: "nav-spacer" }),
    ...NAV.slice(PRIMARY).map(item),
  );
  const here = state.route.view === "task" ? runKey(state.route.jobID) : null;
  const crumbs = [
    h("a", { href: "#/line" }, "factory"),
    state.repoFilter
      ? h(
          "a",
          {
            href: "#/line",
            onclick: (e) => {
              e.preventDefault();
              setRepo(state.repoFilter);
            },
            title: "Show every repo",
          },
          short(state.repoFilter),
        )
      : null,
    here ? h("a", { href: "#/line" }, "Line") : null,
    h("span", { class: "here" }, here ? `#${here.issue}` : (NAV.find(([id]) => id === view)?.[1] ?? "Inbox")),
  ].filter(Boolean);
  document.getElementById("crumbs").replaceChildren(...crumbs.flatMap((c, i) => (i ? [svg(CHEVRON), c] : [c])));
}

// The feed follows the newest card unless the reader scrolled up to look at an older one.
function render() {
  const main = document.getElementById("view");
  const focused = document.activeElement?.id === "composer" ? document.getElementById("composer").value : null;
  const feed = document.getElementById("feed");
  const follow = !feed || feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  const top = feed?.scrollTop ?? 0;
  const open = document.querySelector(".run-files")?.open;
  main.dataset.view = state.route.view;
  main.replaceChildren(h("div", { class: "page" }, (VIEWS[state.route.view] || inboxView)()));
  const next = document.getElementById("feed");
  if (next) next.scrollTop = follow ? next.scrollHeight : top;
  if (open) document.querySelector(".run-files")?.setAttribute("open", "");
  if (focused != null) {
    const c = document.getElementById("composer");
    if (c) {
      c.value = focused;
      c.focus();
    }
  }
  renderNav();
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
  } catch (e) {
    state.error.inbox = e.message;
  }
  document.getElementById("repo-label").textContent =
    state.repos.length > 1 ? plural(state.repos.length, "repo") : short(state.repo);
  renderNav();
}

// A newer request wins, so a slow response can never overwrite a fresher one.
const loaders = {};
function loadView() {
  const spec = LOADERS[state.route.view];
  if (!spec) return Promise.resolve();
  const [name, path] = spec;
  loaders[name] ||= createStatusLoader({
    request: () => api(path),
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

async function toggles() {
  const t = await api("/api/toggles").catch(() => null);
  if (!t) return;
  for (const [id, key] of [
    ["toggle-auto-start", "auto_start"],
    ["toggle-auto-approve", "auto_approve_low_risk"],
  ]) {
    const box = document.getElementById(id);
    box.checked = t[key];
    box.addEventListener("change", () => post("/api/toggles", { key, value: box.checked }));
  }
}

window.addEventListener("hashchange", onRoute);
onRoute();
loadInbox().then(render);
toggles();
setInterval(() => {
  loadInbox().then(() => state.route.view === "inbox" && !document.activeElement?.closest?.("#composer") && render());
  loadView();
}, 5000);
