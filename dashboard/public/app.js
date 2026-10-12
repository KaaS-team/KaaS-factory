// The factory cockpit. Vanilla ES modules, no build step. Every string from
// the server goes in as a text node (see h()); no markup is ever built from it.

import { routeFromHash } from "/lib/routes.js";
import { createStatusLoader } from "/lib/status-loader.js";
import { formatElapsed } from "/lib/run-metrics.js";
import { ACTIVE, stationStates, WAITING } from "/lib/stations.js";

const ACTION_LABEL = { approve: "Approve plan", revise: "Request changes", answer: "Send answer", retry: "Retry", cancel: "Cancel run" };
const REVIEW_KINDS = new Set(["review-pr", "merge-dry-run"]);
const KIND_LABEL = { "approve-plan": "Plan to approve", "answer-question": "Question for you", "review-pr": "Pull request to review", "merge-dry-run": "Ready to merge", parked: "Needs a human", failed: "Failed", budget: "Over budget" };
const ICONS = {
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  line: "M4 6h10M4 12h16M4 18h7",
  runs: "M4 5h16M4 10h16M4 15h16M4 20h10",
  analytics: "M5 20V10M12 20V4M19 20v-7",
  agents: "M8 8h8v8H8zM4 10v4M20 10v4M10 4h4M10 20h4",
  workflows: "M4 5h6v4H4zM14 15h6v4h-6zM7 9v3h10v3",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  theme: "M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z",
};
const NAV = [["inbox", "Inbox"], ["line", "Line"], ["runs", "Runs"], ["workflows", "Workflows"], ["analytics", "Analytics"], ["agents", "Agents"], ["settings", "Settings"]];

const state = { route: routeFromHash(location.hash), inbox: [], repo: "", repos: [], repoFilter: "", selected: null, thread: null, review: null, filter: "all", data: {}, error: {} };

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
const tone = (status) => (status === "shipped" ? "ok" : ["failed", "rejected"].includes(status) ? "bad" : WAITING.has(status) ? "warn" : ACTIVE.has(status) ? "live" : "");
const statusText = (s) => s.replace(/-/g, " ");
const cleanBody = (body) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

async function api(path, init) {
  const res = await fetch(path, init);
  if (res.status === 401) { showLogin(); throw new Error("Sign in to continue"); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---- states shared by every view ---- */
const quiet = (title, hint, ...extra) =>
  h("div", { class: "quiet-state" }, h("div", { class: "quiet-state-mark", "aria-hidden": "true" }, h("i"), h("i"), h("i")), h("strong", null, title), h("span", null, hint), ...extra);
const heading = (title, lede, ...extra) => h("div", { class: "page-heading" }, h("div", null, h("h1", null, title), lede && h("p", { class: "lede" }, lede)), ...extra);
const stateOr = (name, ready) => {
  if (state.error[name]) return quiet("Could not load this view", state.error[name]);
  if (!state.data[name]) return quiet("Loading", "Reading the factory's state.");
  return ready(state.data[name]);
};

/* ---- Line ---- */
function stationsFor(row) {
  return stationStates(row.run, row.stages).map(({ name, ms, live, failed, done }) => {
    const grow = Math.max(1, Math.min(8, Math.round(ms / 30000)));
    return { name, node: h("div", { class: "station", style: `flex-grow:${grow}`, "data-done": done, "data-live": live, "data-failed": failed, title: `${name}${ms ? ` · ${formatElapsed(ms)}` : ""}` }) };
  });
}

function lineRow(row) {
  const { run } = row;
  const stations = stationsFor(row);
  const needs = WAITING.has(run.status);
  const agents = [...new Set(row.stages.map((s) => s.agent))].join(", ");
  return h("button", { class: "line-row", type: "button", onclick: () => (needs ? go("inbox", run.issue) : (location.hash = `#/runs/${run.issue}`)) },
    h("div", null, h("div", { class: "line-title" }, `#${run.issue} ${run.title}`), h("div", { class: "line-sub" }, [agents, `started ${age(run.started_at)} ago`].filter(Boolean).join(" · "))),
    h("div", { class: "stations-col" }, h("div", { class: "stations" }, stations.map((s) => s.node)), h("div", { class: "station-names" }, stations.map((s) => h("span", null, s.name)))),
    h("div", { class: `line-state${needs ? " needs-you" : ""}` }, h("span", { class: "num" }, needs ? "Waiting on you" : statusText(run.status)), needs && run.reason ? h("span", { class: "reason", title: run.reason }, run.reason) : null, `${money(run.cost_usd)} · ${compact(run.tokens_in + run.tokens_out)} tokens`));
}

function lineView() {
  return h("section", null, heading("Line", "Every issue moves left to right. Each block is a stage, sized by how long it took."),
    stateOr("line", ({ rows }) => rows.length ? h("div", { class: "line" }, rows.map(lineRow)) : quiet("Nothing on the line", "Label an issue factory:ready to start a run.")));
}

/* ---- Inbox ---- */
function isSelected(i) { return state.selected != null && state.selected.repo === i.repo && state.selected.issue === i.issue; }

async function selectItem(item) {
  state.selected = { repo: item.repo, issue: item.issue };
  state.thread = null;
  state.review = null;
  render();
  const q = `?repo=${encodeURIComponent(item.repo)}`;
  const wantsReview = REVIEW_KINDS.has(item.kind);
  const [thread, review] = await Promise.allSettled([api(`/api/issues/${item.issue}/thread${q}`), wantsReview ? api(`/api/issues/${item.issue}/review${q}`) : Promise.resolve(null)]);
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
  } catch (e) { alert(e.message); }
  render();
}

async function mergeApprove(item) {
  try {
    const r = await post(`/api/issues/${item.issue}/merge`, { repo: item.repo });
    if (r.decision.outcome !== "merge") { alert(`Not merged:\n${r.decision.refusals.map((x) => `- ${x.detail}`).join("\n")}`); return; }
    state.selected = null;
    state.review = null;
    await Promise.all([loadInbox(), loadView()]);
  } catch (e) { alert(e.message); }
  render();
}

function actionLabel(item, a) { return REVIEW_KINDS.has(item.kind) && a === "cancel" ? "Close" : ACTION_LABEL[a]; }

function reviewPanel() {
  const r = state.review;
  if (!r) return quiet("Loading", "Reading the pull request.");
  if (r.error) return quiet("Could not load the review", r.error);
  const ciTone = r.ci.status === "passed" ? "ok" : r.ci.status === "failed" ? "bad" : "warn";
  return h("div", { class: "review" },
    h("dl", { class: "kv" },
      h("dt", null, "Pull request"), h("dd", null, h("a", { href: r.pr.url, target: "_blank", rel: "noreferrer" }, `#${r.pr.number}`)),
      h("dt", null, "CI"), h("dd", null, h("span", { class: "status", "data-tone": ciTone }, statusText(r.ci.status))),
      r.gate ? [h("dt", null, "Gate"), h("dd", null, `${r.gate.status} · ${r.gate.line}`)] : null,
      r.verify?.result ? [h("dt", null, "Verify"), h("dd", null, r.verify.result)] : null),
    r.verify?.findings?.length ? h("div", null, h("h3", null, "Verify findings"),
      h("ul", { class: "plain-list" }, r.verify.findings.map((f) => h("li", null, typeof f === "string" ? f : `${f.severity}: ${f.what}`)))) : null,
    r.stages.length ? h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Stage", "Agent", "Model", "Cost"].map((c, i) => h("th", { class: i === 3 ? "num" : "" }, c)))),
      h("tbody", null, r.stages.map((s) => h("tr", null, h("td", null, s.stage), h("td", null, s.agent), h("td", null, s.model || "default"), h("td", { class: "num" }, s.usage_complete === 0 ? "Not reported" : money(s.cost_usd))))))) : null,
    h("h3", { style: "margin-top:1rem" }, "Diff"),
    h("pre", { class: "log" }, r.diff || "No diff available."));
}

function conversation(item) {
  const t = state.thread;
  const body = !t ? quiet("Loading", "Reading the issue thread.")
    : t.error ? quiet("Could not load the thread", t.error)
    : h("div", { class: "thread" }, [{ author: "issue", body: t.body, bot: false }, ...(t.comments || []).map((c) => ({ author: c.author, body: c.body, bot: c.body.includes("<!-- factory:") }))]
        .filter((m) => cleanBody(m.body))
        .map((m) => h("div", { class: `msg${m.bot ? " bot" : ""}` }, h("header", null, m.bot ? "factory" : m.author), cleanBody(m.body))));
  const needsText = item.actions.filter((a) => a === "revise" || a === "answer");
  const box = needsText.length ? h("textarea", { class: "field-control", id: "composer", rows: "3", placeholder: item.kind === "answer-question" ? "Your answer" : "What should change?", "aria-label": "Your reply" }) : null;
  const isReview = REVIEW_KINDS.has(item.kind);
  return h("div", { class: "panel" },
    h("div", { class: "panel-pad" }, h("h2", null, `#${item.issue} ${item.title}`), h("span", { class: "muted" }, `${item.repo} · ${item.label.replace("factory:", "").replace(/-/g, " ")} · waiting ${age(item.waitingSince)}`)),
    isReview ? h("div", { class: "panel-pad" }, reviewPanel()) : null,
    body,
    h("div", { class: "composer" }, box, h("div", { class: "actions" },
      isReview ? h("button", { class: "btn btn-primary", type: "button", onclick: () => mergeApprove(item) }, "Approve and merge") : null,
      item.actions.map((a) =>
        h("button", { class: `btn${a === "approve" || a === "answer" ? " btn-primary" : a === "cancel" ? " btn-danger" : ""}`, type: "button",
          onclick: () => { const text = box ? box.value : ""; if ((a === "revise" || a === "answer") && !text.trim()) { box.focus(); return; } actOn(item, a, text); } }, actionLabel(item, a))))));
}

function repoFilterControl() {
  if (state.repos.length <= 1) return null;
  return h("select", { class: "field-control repo-filter", "aria-label": "Filter by repo",
    onchange: (e) => { state.repoFilter = e.target.value; loadInbox().then(render); } },
    h("option", { value: "", selected: state.repoFilter === "" }, "All repos"),
    ...state.repos.map((r) => h("option", { value: r, selected: state.repoFilter === r }, r)));
}

function inboxView() {
  const items = state.inbox;
  const multiRepo = state.repos.length > 1;
  const item = items.find(isSelected);
  return h("section", null, heading("Inbox", "Everything the factory is waiting on you for.", repoFilterControl()),
    !items.length ? quiet("Nothing is waiting on you", "The factory will list plans to approve and questions to answer here.")
    : h("div", { class: "split", "data-open": String(Boolean(item)) },
      h("div", { class: "list-col" }, h("div", { class: "list" }, items.map((i) =>
        h("button", { class: "list-item", type: "button", "aria-current": String(isSelected(i)), onclick: () => selectItem(i) },
          h("span", { class: "kind" }, KIND_LABEL[i.kind], multiRepo ? h("span", { class: "muted repo-tag" }, ` · ${i.repo}`) : null),
          h("strong", null, `#${i.issue} ${i.title}`), h("span", { class: "muted" }, `waiting ${age(i.waitingSince)}`), h("span", { class: "muted" }, i.ask.slice(0, 110)))))),
      h("div", { class: "detail-col" }, item ? [h("button", { class: "btn back", type: "button", onclick: () => { state.selected = null; state.review = null; render(); } }, "Back to inbox"), conversation(item)] : quiet("Pick an item", "Its conversation and actions show up here."))));
}

/* ---- Runs ---- */
const FILTERS = [["all", "All", () => true], ["active", "Active", (r) => ACTIVE.has(r.status)], ["needs", "Needs you", (r) => WAITING.has(r.status)], ["done", "Finished", (r) => ["shipped", "cancelled", "rejected"].includes(r.status)]];

function runsView() {
  return h("section", null, heading("Runs", "Every run the factory has started, newest first."),
    stateOr("runs", ({ runs }) => {
      const pick = FILTERS.find((f) => f[0] === state.filter)[2];
      const rows = runs.filter(pick);
      return h("div", null,
        h("div", { class: "tabs", role: "group", "aria-label": "Filter runs" }, FILTERS.map(([id, label, fn]) => h("button", { class: "tab", type: "button", "aria-pressed": String(state.filter === id), onclick: () => { state.filter = id; render(); } }, `${label} ${runs.filter(fn).length}`))),
        rows.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Issue", "Status", "Stage", "Cost", "Updated"].map((c, i) => h("th", { class: i >= 3 ? "num" : "" }, c)))),
          h("tbody", null, rows.map((r) => h("tr", { "data-href": r.issue, tabindex: "0", onclick: () => (location.hash = `#/runs/${r.issue}`), onkeydown: (e) => e.key === "Enter" && (location.hash = `#/runs/${r.issue}`) },
            h("td", null, `#${r.issue} ${r.title}`), h("td", null, h("span", { class: "status", "data-tone": tone(r.status) }, statusText(r.status))), h("td", null, r.stage), h("td", { class: "num" }, money(r.cost_usd)), h("td", { class: "num" }, age(r.updated_at)))))))
        : quiet("No runs match", state.filter === "all" ? "Label an issue factory:ready to start one." : "Try another filter."));
    }));
}

/* ---- Run detail sheet ---- */
const sheet = { issue: null, run: null, stages: null, artifacts: null, events: null, preview: null };

async function openSheet(issue) {
  Object.assign(sheet, { issue, run: null, stages: null, artifacts: null, events: null, preview: null });
  renderSheet();
  const runs = state.data.runs ?? (await api("/api/runs").catch(() => null));
  if (sheet.issue !== issue) return;
  const run = (runs?.runs || []).find((r) => r.issue === issue);
  if (!run) { sheet.run = { missing: true }; return renderSheet(); }
  sheet.run = run;
  renderSheet();
  const [stages, artifacts, events] = await Promise.allSettled([api(`/api/runs/${run.id}/stages`), api(`/api/issues/${issue}/artifacts`), api(`/api/runs/${run.id}/events`)]);
  if (sheet.issue !== issue) return; // the sheet moved on while these loaded
  sheet.stages = stages.value?.stages ?? [];
  sheet.artifacts = artifacts.value?.files ?? [];
  sheet.events = events.value?.events ?? [];
  renderSheet();
}

async function preview(name) {
  const res = await fetch(`/api/issues/${sheet.issue}/artifacts?file=${encodeURIComponent(name)}`);
  sheet.preview = { name, text: res.ok ? await res.text() : "Could not read this file.", truncated: res.headers.get("x-artifact-truncated") === "true" };
  renderSheet();
}

function renderSheet() {
  const root = document.getElementById("sheet-root");
  root.replaceChildren();
  if (sheet.issue == null) return;
  const close = () => { location.hash = "#/runs"; };
  const run = sheet.run;
  const body = !run ? quiet("Loading", "Reading this run.") : run.missing ? quiet("No run for this issue", "It may not have started yet.") : [
    h("dl", { class: "kv" },
      h("dt", null, "Status"), h("dd", null, h("span", { class: "status", "data-tone": tone(run.status) }, statusText(run.status))),
      h("dt", null, "Stage"), h("dd", null, run.stage),
      h("dt", null, "Cost"), h("dd", null, `${money(run.cost_usd)} · ${compact(run.tokens_in + run.tokens_out)} tokens · ${run.tool_calls} tool calls`),
      run.pr_url && [h("dt", null, "Pull request"), h("dd", null, h("a", { href: run.pr_url, target: "_blank", rel: "noreferrer" }, run.pr_url))],
      run.gate_line && [h("dt", null, "Gates"), h("dd", null, run.gate_line)],
      run.reason && [h("dt", null, "Reason"), h("dd", null, run.reason)]),
    h("h2", null, "Stages"),
    !sheet.stages ? h("p", { class: "muted" }, "Loading") : sheet.stages.length ? h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Stage", "Agent", "Took", "Tokens", "Cost"].map((c, i) => h("th", { class: i >= 2 ? "num" : "" }, c)))),
      h("tbody", null, sheet.stages.map((s) => h("tr", null, h("td", null, h("span", { class: "status", "data-tone": s.exit_code === 0 && !s.killed_reason ? "ok" : "bad" }, s.stage)), h("td", null, s.agent), h("td", { class: "num" }, formatElapsed(s.duration_ms)),
        h("td", { class: "num" }, s.usage_complete !== 0 && s.tokens_in + s.tokens_out ? compact(s.tokens_in + s.tokens_out) : "Not reported"), h("td", { class: "num" }, s.usage_complete === 0 ? "Not reported" : money(s.cost_usd))))))) : h("p", { class: "muted" }, "No stage has finished yet."),
    h("h2", { style: "margin-top:1.5rem" }, "Files from the run"),
    !sheet.artifacts ? h("p", { class: "muted" }, "Loading") : sheet.artifacts.length ? h("div", { class: "actions" }, sheet.artifacts.map((f) => h("button", { class: "btn", type: "button", onclick: () => preview(f.name) }, `${f.name} (${compact(f.size)}B)`))) : h("p", { class: "muted" }, "This run left no files on this machine."),
    sheet.preview && [h("p", { class: "muted" }, `${sheet.preview.name}${sheet.preview.truncated ? " (first 1 MiB)" : ""} `, h("a", { href: `/api/issues/${sheet.issue}/artifacts?file=${encodeURIComponent(sheet.preview.name)}&download=1` }, "Download")), h("pre", { class: "log" }, sheet.preview.text)],
    h("h2", { style: "margin-top:1.5rem" }, "Log"),
    !sheet.events ? h("p", { class: "muted" }, "Loading") : sheet.events.length ? h("pre", { class: "log" }, sheet.events.slice(-200).map((e) => `[${e.stage}/${e.kind}] ${e.text}`).join("\n")) : h("p", { class: "muted" }, "Nothing logged yet."),
  ];
  root.append(h("div", { class: "sheet-backdrop", onclick: close }),
    h("aside", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": `Run for issue ${sheet.issue}` },
      h("button", { class: "btn sheet-close", type: "button", onclick: close }, "Close"), h("h2", null, run && !run.missing ? `#${run.issue} ${run.title}` : `#${sheet.issue}`), body));
  root.querySelector(".sheet .btn")?.focus();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet.issue != null) location.hash = "#/runs"; });

/* ---- Analytics ---- */
function bars(title, buckets, unit) {
  const max = Math.max(...buckets.map((b) => b.costUsd), 0.0001);
  return h("div", null, h("h2", null, title), h("div", { class: "bars" }, buckets.map((b) =>
    h("div", { class: "bar" }, h("span", null, b.key), h("div", { class: "bar-track" }, h("div", { class: "bar-fill", style: `width:${Math.max(2, (b.costUsd / max) * 100)}%` })),
      h("span", { class: "bar-note" }, `${money(b.costUsd)} · ${b.attempts} ${b.attempts === 1 ? "attempt" : "attempts"} · ${formatElapsed(b.avgDurationMs)} avg`)))));
}

function analyticsView() {
  return h("section", null, heading("Analytics", "What the factory delivers, and what it costs."),
    stateOr("analytics", (a) => !a.byStage.length ? quiet("No stage has finished yet", "Numbers appear after the first run completes a stage.") : h("div", null,
      h("div", { class: "kpis" },
        [[a.successRate == null ? "None yet" : `${Math.round(a.successRate * 1000) / 10}%`, "Runs that shipped, of those finished"], [String(a.runs), "Runs started"], [money(a.spend7dUsd), "Spent in 7 days"], [money(a.spend30dUsd), "Spent in 30 days"]]
          .map(([v, l]) => h("div", { class: "kpi" }, h("span", { class: "value" }, v), h("span", { class: "label" }, l)))),
      bars("Cost by stage", a.byStage), bars("Cost by agent", a.byAgent), bars("Cost by model", a.byModel))));
}

/* ---- Agents ---- */
function agentsView() {
  return h("section", null, heading("Agents", "The coding agents the factory can run, and which stages each one serves."),
    stateOr("agents", (a) => !a.agents.length ? quiet("No agents configured", "Add one under agents in .factory/config.json.") : h("div", { class: "table-wrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Agent", "Command", "Installed", "Pinned version", "Verified live", "Doctor", "Stages"].map((c) => h("th", null, c)))),
      h("tbody", null, a.agents.map((r) => h("tr", null,
        h("td", null, h("span", { class: "status", "data-tone": r.configured ? "ok" : "" }, r.name), r.configured ? null : h("span", { class: "muted" }, " not configured")),
        h("td", null, r.binary), h("td", null, !r.configured ? "Not configured" : r.installed ? (r.version || "Installed") : "Not installed"), h("td", null, r.pin || "Not pinned"),
        h("td", null, h("span", { class: "status", "data-tone": r.verified ? "ok" : "warn" }, r.verified ? "Verified" : "Verified by participants: not yet")),
        h("td", null, r.checks.length ? h("ul", { class: "plain-list" }, r.checks.filter((c) => !c.ok).map((c) => h("li", { title: c.detail }, c.name))) : "", r.checks.length && r.checks.every((c) => c.ok) ? "All checks pass" : null),
        h("td", null, r.stages.length ? r.stages.join(", ") : "None"))))))));
}

/* ---- Workflows: factory harness inventory and validate ---- */
const ROUTED = (w) => (w.routedTypes.includes("*") ? "The repo's workflow" : w.routedTypes.length ? `Issue types: ${w.routedTypes.join(", ")}` : "Not routed");

function workflowsView() {
  return h("section", null, heading("Workflows", "Every workflow this repo can run, the issue types routed to each, and whether they all load."),
    stateOr("workflows", (d) => !d.available ? quiet("No repo to read", d.reason) : h("div", null,
      h("div", { class: "panel panel-pad harness" }, h("h2", null, "Harness check"),
        d.problems.length
          ? h("ul", { class: "plain-list" }, d.problems.map((p) => h("li", null, h("span", { class: "status", "data-tone": "bad" }, p))))
          : h("span", { class: "status", "data-tone": "ok" }, "Every workflow loads, and every route names one that exists.")),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Workflow", "From", "Runs for", "Steps", "Schedule"].map((c) => h("th", null, c)))),
        h("tbody", null, d.workflows.map((w) => h("tr", null,
          h("td", null, h("span", { class: "status", "data-tone": w.problems.length ? "bad" : "ok" }, w.name), w.problems.length ? h("div", { class: "muted" }, w.problems.join("; ")) : null),
          h("td", null, w.source === "repo" ? ".factory/workflows" : "Runner"),
          h("td", null, ROUTED(w)),
          h("td", null, h("span", { class: "steps" }, w.steps.map((st) => h("code", { title: st.runtime ? `runs on ${st.runtime}` : st.uses }, st.uses === st.id ? st.id : `${st.id} (${st.uses})`)))),
          h("td", null, w.cron.length || (w.events ?? []).length
            ? [...w.cron.map((c) => h("div", null, `${c.schedule} ${c.tz}: ${c.title}`)), ...(w.events ?? []).map((t) => h("div", null, `On ${t}`))]
            : "On issue labels")))))))));
}

/* ---- Settings: runtimes and leases ---- */
function settingsView() {
  return h("section", null, heading("Settings", "Where gates and checks run, and which worker holds each issue right now."),
    stateOr("settings", (d) => !d.available ? quiet("No repo to read", d.reason) : h("div", null,
      h("dl", { class: "kv" }, h("dt", null, "Slots"), h("dd", null, String(d.slots)), h("dt", null, "Daily cap"), h("dd", null, d.dailyUsd == null ? "None set" : money(d.dailyUsd))),
      h("h2", null, "Runtimes"),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Runtime", "Kind", "Target", "Used by"].map((c) => h("th", null, c)))),
        h("tbody", null, d.runtimes.map((r) => h("tr", null,
          h("td", null, h("span", { class: "status", "data-tone": r.usedBy.length ? "live" : "" }, r.name), r.builtin ? h("span", { class: "muted" }, " built in") : null),
          h("td", null, r.kind), h("td", null, h("code", null, r.target)),
          h("td", null, r.usedBy.length ? r.usedBy.join(", ") : "Nothing in this repo")))))),
      h("h2", { class: "section-gap" }, "Issue leases"),
      d.leasesError ? h("p", { class: "error" }, `Could not read the lease refs: ${d.leasesError}`)
        : !d.leases.length ? quiet("No leases", "A worker takes refs/factory/lease/<issue> while it runs an issue.")
        : h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, ["Issue", "Holder", "State"].map((c) => h("th", null, c)))),
          h("tbody", null, d.leases.map((l) => h("tr", null, h("td", null, l.key), h("td", null, l.holder),
            h("td", null, h("span", { class: "status", "data-tone": l.live ? "live" : "" }, l.live ? `Held, expires in ${Math.max(1, Math.round((l.expiresAt - Date.now()) / 1000))}s` : l.expiresAt === 0 ? "Released" : "Expired"))))))))));
}

/* ---- shell ---- */
const VIEWS = { inbox: inboxView, line: lineView, runs: runsView, task: runsView, workflows: workflowsView, analytics: analyticsView, agents: agentsView, settings: settingsView };
const LOADERS = { line: ["line", "/api/line"], runs: ["runs", "/api/runs"], task: ["runs", "/api/runs"], workflows: ["workflows", "/api/workflows"], analytics: ["analytics", "/api/analytics"], agents: ["agents", "/api/agents"], settings: ["settings", "/api/settings"] };

function renderNav() {
  const nav = document.getElementById("nav");
  const view = state.route.view === "task" ? "runs" : state.route.view;
  nav.replaceChildren(...NAV.map(([id, label]) => h("a", { class: "nav-item", href: `#/${id}`, "aria-current": view === id ? "page" : false }, svg(ICONS[id]), label, id === "inbox" && state.inbox.length ? h("span", { class: "badge" }, String(state.inbox.length)) : null)),
    h("button", { class: "nav-item", type: "button", "aria-label": "Switch light and dark", onclick: toggleTheme }, svg(ICONS.theme), "Theme"));
}

function render() {
  const main = document.getElementById("view");
  const focused = document.activeElement?.id === "composer" ? document.getElementById("composer").value : null;
  main.replaceChildren((VIEWS[state.route.view] || inboxView)());
  if (focused != null) { const c = document.getElementById("composer"); if (c) { c.value = focused; c.focus(); } }
  renderNav();
}

function toggleTheme() {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("factory-theme", next); } catch {}
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
  document.getElementById("view").replaceChildren(h("form", { class: "login", onsubmit: async (e) => {
    e.preventDefault();
    try { await post("/api/session", { token: e.target.token.value }); location.reload(); } catch { e.target.querySelector(".error").textContent = "That token was not accepted."; }
  } }, h("h1", null, "Sign in"), h("label", { class: "muted", for: "token" }, "Dashboard token"), h("input", { class: "field-control", id: "token", name: "token", type: "password", autocomplete: "current-password" }), h("p", { class: "error", role: "alert" }), h("button", { class: "btn btn-primary", type: "submit" }, "Sign in")));
}

async function loadInbox() {
  try {
    const q = state.repoFilter ? `?repo=${encodeURIComponent(state.repoFilter)}` : "";
    const r = await api(`/api/inbox${q}`);
    state.inbox = r.items;
    state.repo = r.repo;
    state.repos = r.repos || [];
    state.error.inbox = null;
  } catch (e) { state.error.inbox = e.message; }
  document.getElementById("repo-label").textContent = state.repo || (state.repos.length > 1 ? `${state.repos.length} repos` : "");
  renderNav();
}

// A newer request wins, so a slow response can never overwrite a fresher one.
const loaders = {};
function loadView() {
  const spec = LOADERS[state.route.view];
  if (!spec) return Promise.resolve();
  const [name, path] = spec;
  loaders[name] ||= createStatusLoader({ request: () => api(path), apply: (r) => {
    if (r.kind === "success") { state.data[name] = r.status; state.error[name] = null; } else state.error[name] = r.message;
    render();
  } });
  return loaders[name].refresh();
}

function onRoute() {
  state.route = routeFromHash(location.hash);
  if (state.route.view === "task") openSheet(Number(state.route.jobID));
  else { sheet.issue = null; renderSheet(); }
  render();
  loadView();
}

async function toggles() {
  const t = await api("/api/toggles").catch(() => null);
  if (!t) return;
  for (const [id, key] of [["toggle-auto-start", "auto_start"], ["toggle-auto-approve", "auto_approve_low_risk"]]) {
    const box = document.getElementById(id);
    box.checked = t[key];
    box.addEventListener("change", () => post("/api/toggles", { key, value: box.checked }));
  }
}

window.addEventListener("hashchange", onRoute);
onRoute();
loadInbox().then(render);
toggles();
setInterval(() => { loadInbox().then(() => state.route.view === "inbox" && !document.activeElement?.closest?.("#composer") && render()); loadView(); }, 5000);
