// One run as a conversation: each stage folds like a tool call in a chat app, the plan card asks
// for approval inline, the composer queues a reply you can still undo, and the right pane answers
// what a reviewer asks (lib/pane.js).

import { createSendQueue } from "./actions.js";
import { age, api, h, heading, isOperator, money, quiet, runKey, shell, state, statusText, tone } from "./core.js";
import { rightPane } from "./pane.js";
import { feedCard, stageName } from "./run-page.js";
import { WAITING } from "./stations.js";
import { actOn } from "./view-inbox.js";
import { stationsFor } from "./view-line.js";

export const live = {
  key: "",
  items: [],
  next: 0,
  proof: null,
  review: null,
  pane: null,
  tab: "outcome",
  open: {},
  ticks: 0,
  timer: 0,
};
const fresh = (key) => ({ key, items: [], next: 0, proof: null, review: null, pane: null, open: {} });

export async function pollLive() {
  const at = runKey(state.route.jobID);
  if (state.route.view !== "task" || !at) return;
  const key = `${at.repo}#${at.issue}`;
  if (live.key !== key) Object.assign(live, fresh(key));
  const q = `repo=${encodeURIComponent(at.repo || "")}`;
  // The pane and the diff change once per stage, so they are read every tenth tick, not every second.
  const slow = !live.pane || ++live.ticks % 10 === 0;
  const [feed, proof, pane, review] = await Promise.allSettled([
    api(`/api/issues/${at.issue}/live?${q}&from=${live.next}`),
    api(`/api/issues/${at.issue}/proof?${q}`),
    slow ? api(`/api/issues/${at.issue}/pane?${q}`) : Promise.resolve(live.pane),
    slow && !live.review ? api(`/api/issues/${at.issue}/review?${q}`) : Promise.resolve(live.review),
  ]);
  if (live.key !== key) return; // the page moved on while these loaded
  let changed = false;
  if (feed.value) {
    if (feed.value.next < live.next) live.items = [];
    if (feed.value.items.length || feed.value.next < live.next) changed = true;
    live.items.push(...feed.value.items);
    live.next = feed.value.next;
  }
  for (const [name, r] of [
    ["proof", proof],
    ["pane", pane],
    ["review", review],
  ]) {
    const v = r.status === "fulfilled" ? r.value : name === "review" ? { error: r.reason.message } : live[name];
    if (JSON.stringify(v) !== JSON.stringify(live[name])) {
      live[name] = v;
      changed = true;
    }
  }
  if (changed) shell.render();
}

// The feed as one fold per stage: the stage card opens it and its exit card closes it.
export function stageGroups(items) {
  const groups = [];
  for (const item of items) {
    if (item.kind === "stage" || !groups.length) groups.push({ stage: item.stage ?? "", items: [], exit: null });
    const g = groups.at(-1);
    if (item.kind === "stage") continue;
    if (item.kind === "exit") g.exit = item;
    else g.items.push(item);
  }
  return groups;
}

function timeline(items) {
  const op = isOperator();
  const groups = stageGroups(items);
  if (!groups.length) return quiet("Nothing yet", "The agent's reads, edits and test runs show here as it works.");
  return groups.map((g, i) => {
    const last = i === groups.length - 1;
    const id = `${i}:${g.stage}`;
    const open = live.open[id] ?? (last && !g.exit);
    const steps = g.items.filter((x) => x.kind === "tool").length;
    const verdict = !g.exit ? "working" : g.exit.ok ? "finished" : "stopped";
    return h(
      "details",
      {
        class: "fold",
        open,
        "data-tone": !g.exit ? "live" : g.exit.ok ? "pass" : "fail",
        ontoggle: (e) => (live.open[id] = e.target.open),
      },
      h(
        "summary",
        null,
        h("strong", null, stageName(g.stage) || "Starting"),
        h("span", { class: "muted" }, ` ${verdict}${steps ? `, ${steps} ${steps === 1 ? "step" : "steps"}` : ""}`),
      ),
      g.items.map((x) => feedCard(op || x.kind !== "done" ? x : { ...x, costUsd: null }, h)),
      g.exit ? feedCard(g.exit, h) : null,
    );
  });
}

// The plan card: the same two words the inbox uses, so Approve plan comes back as Plan approved.
function planCard(item) {
  return h(
    "div",
    { class: "card plan-card" },
    h("strong", null, "The plan is ready for you"),
    h("p", { class: "muted" }, "Read it in the issue, then approve it or say what should change."),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "btn btn-primary", type: "button", onclick: () => actOn(item, "approve", "") },
        "Approve plan",
      ),
      h(
        "button",
        { class: "btn", type: "button", onclick: () => document.getElementById("composer")?.focus() },
        "Request changes",
      ),
    ),
  );
}

const queue = createSendQueue({
  send: (m) => actOn(m.item, m.action, m.text),
  onChange: () => shell.render(),
});
export const sendQueue = queue;

function composer(item) {
  const action = item?.actions.includes("answer") ? "answer" : item?.actions.includes("revise") ? "revise" : null;
  const box = h("textarea", {
    class: "field-control",
    id: "composer",
    rows: "2",
    disabled: !action,
    "aria-label": "Your reply",
    placeholder:
      action === "answer"
        ? "Your answer"
        : action
          ? "What should change in the plan?"
          : "You can reply here when the run asks you something.",
  });
  return h(
    "form",
    {
      class: "composer run-composer",
      onsubmit: (e) => {
        e.preventDefault();
        if (!action || !box.value.trim()) return box.focus();
        queue.enqueue({ item, action, text: box.value.trim() });
        box.value = "";
      },
    },
    queue.items.map((m) =>
      h(
        "div",
        { class: "queued", role: "status" },
        h("span", null, `${action === "answer" ? "Sending your answer" : "Sending your changes"} in a few seconds`),
        h("button", { class: "btn", type: "button", onclick: () => queue.undo(m) }, "Undo"),
      ),
    ),
    box,
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        { class: "btn btn-primary", type: "submit", disabled: !action },
        action === "revise" ? "Request changes" : "Send answer",
      ),
    ),
  );
}

export const insertQuote = (text) => {
  const c = document.getElementById("composer");
  if (!c || c.disabled) return (state.toast = "Comments go in once the run waits on you.");
  c.value += text;
  c.focus();
};

export function runView() {
  const at = runKey(state.route.jobID);
  if (!at) return h("section", null, quiet("No such run", "Pick a run from the Line."));
  const row = state.data.line?.rows.find((r) => r.run.issue === at.issue && (r.repo ?? state.repo) === at.repo);
  const run = row?.run;
  const item = state.inbox.find((i) => i.issue === at.issue && i.repo === at.repo);
  const stations = row ? stationsFor(row) : [];
  const sub = [at.repo, run && `started ${age(run.started_at)} ago`, run && isOperator() && money(run.cost_usd)]
    .filter(Boolean)
    .join(", ");
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
          timeline(live.items),
          item?.kind === "approve-plan" && item.actions.includes("approve") ? planCard(item) : null,
        ),
        composer(item),
      ),
      rightPane({
        tab: live.tab,
        proof: live.proof,
        review: live.review,
        pane: live.pane,
        onTab: (id) => {
          live.tab = id;
          shell.render();
        },
        onComment: insertQuote,
      }),
    ),
  );
}

