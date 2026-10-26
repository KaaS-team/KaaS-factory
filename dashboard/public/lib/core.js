// What every view shares: the page state, the element builder, the API client and the shell hooks.
// app.js fills `shell` at boot, so a view can ask for a render without importing the shell back.
// Every string from the server goes in as a text node (see h()); no markup is ever built from it.

import { routeFromHash } from "./routes.js";
import { ACTIVE, WAITING } from "./stations.js";

export const state = {
  route: routeFromHash(typeof location === "undefined" ? "" : location.hash),
  inbox: [],
  repo: "",
  repos: [],
  repoFilter: "",
  selected: null,
  thread: null,
  review: null,
  filter: "all",
  settingsTab: "general",
  data: {},
  error: {},
  // Who is looking: cost, models and hosts show only to an operator or owner.
  me: { role: "viewer" },
  toast: "",
  // The relay's last inbox, shown read-only while the dashboard is out of reach.
  relay: null,
  offline: false,
};

export const shell = {
  render: () => {},
  go: () => {},
  loadInbox: async () => {},
  loadView: async () => {},
  setRepo: () => {},
  showLogin: () => {},
  startFollowing: () => {},
};

const RANK = ["viewer", "approver", "operator", "owner"];
export const isOperator = (me = state.me) => RANK.indexOf(me?.role) >= RANK.indexOf("operator");

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true && !/^(data|aria)-/.test(k) ? "" : String(v));
  }
  // Deep, since a view often maps to [dt, dd] pairs inside a list of children.
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

export const svgEl = (tag, attrs) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
export const svg = (path) => {
  const s = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  s.append(svgEl("path", { d: path }));
  return s;
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
const FAILED = ["failed", "rejected"];
export const glyphKind = (status) =>
  status === "shipped"
    ? "shipped"
    : FAILED.includes(status)
      ? "failed"
      : WAITING.has(status)
        ? "waiting"
        : ACTIVE.has(status)
          ? "live"
          : status === "queued"
            ? "queued"
            : "quiet";
export function glyph(kind, label) {
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

export const repoOf = (row) => row.repo ?? state.repo;
export const inRepo = (repo) => !state.repoFilter || repo === state.repoFilter;
export const short = (repo) => (repo || "").split("/").pop();
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const initials = (name) => (name === "factory" ? "F" : name.slice(0, 2).toUpperCase());
export const money = (n) => `$${(n || 0).toFixed(2)}`;
export const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
export function age(iso) {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}
export const tone = (status) =>
  status === "shipped"
    ? "ok"
    : FAILED.includes(status)
      ? "bad"
      : WAITING.has(status)
        ? "warn"
        : ACTIVE.has(status)
          ? "live"
          : "";
export const statusText = (s) => s.replace(/-/g, " ");
export const cleanBody = (body) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

// #/runs/<owner>/<name>/<issue>, or #/runs/<issue> for the configured repo.
export const runKey = (jobID) => {
  const m = /^(?:(.+)\/)?(\d+)$/.exec(jobID);
  return m ? { repo: m[1] || state.repo, issue: Number(m[2]) } : null;
};
export const runHref = (repo, issue) => `#/runs/${repo ? `${repo}/` : ""}${issue}`;

export async function api(path, init) {
  // A request that never answers would leave a view on Loading forever.
  const res = await fetch(path, { signal: AbortSignal.timeout(20_000), ...init });
  if (res.status === 401) {
    shell.showLogin();
    throw new Error("Sign in to continue");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
export const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---- states shared by every view ---- */
export const quiet = (title, hint, ...extra) =>
  h(
    "div",
    { class: "quiet-state" },
    h("div", { class: "quiet-state-mark", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("strong", null, title),
    h("span", null, hint),
    ...extra,
  );
export const heading = (title, lede, ...extra) =>
  h(
    "div",
    { class: "page-heading" },
    h("div", null, h("h1", null, title), lede && h("p", { class: "lede" }, lede)),
    ...extra,
  );
export const stateOr = (name, ready) => {
  if (state.error[name]) return quiet("Could not load this view", state.error[name]);
  if (!state.data[name]) return quiet("Loading", "Reading the factory's state.");
  return ready(state.data[name]);
};
export const table = (cols, rows, numFrom = Infinity) =>
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
          cols.map((c, i) => h("th", { class: i >= numFrom ? "num" : "" }, c)),
        ),
      ),
      h("tbody", null, rows),
    ),
  );
