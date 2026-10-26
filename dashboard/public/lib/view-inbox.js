// The Inbox, "Needs you": plans to approve, questions to answer, failed runs. Each row carries
// its one-tap action, so a phone approves a plan or picks an answer without opening the item.

import { ACTION_DONE, actionLabel, choicesOf, needsText, REVIEW_KINDS } from "./actions.js";
import { execSummary } from "./exec-summary.js";
import { markdownText, renderMarkdown } from "./markdown.js";
import { riskBadge } from "./risk-badge.js";
import {
  age,
  api,
  cleanBody,
  glyph,
  h,
  heading,
  initials,
  inRepo,
  isOperator,
  money,
  post,
  quiet,
  shell,
  short,
  state,
  statusText,
  svg,
  table,
} from "./core.js";

export const KIND_LABEL = {
  "approve-plan": "Plan to approve",
  "answer-question": "Question for you",
  "review-pr": "Pull request to review",
  "merge-dry-run": "Ready to merge",
  parked: "Needs a human",
  failed: "Failed",
  budget: "Over budget",
  "stale-pr": "Quiet pull request",
};
const INBOX_ICON = "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5";

const isSelected = (i) => state.selected != null && state.selected.repo === i.repo && state.selected.issue === i.issue;
const clear = () => {
  state.selected = null;
  state.review = null;
};

export async function selectItem(item) {
  state.selected = { repo: item.repo, issue: item.issue };
  state.thread = null;
  state.review = null;
  shell.render();
  const q = `?repo=${encodeURIComponent(item.repo)}`;
  const wantsReview = REVIEW_KINDS.has(item.kind);
  const [thread, review] = await Promise.allSettled([
    api(`/api/issues/${item.issue}/thread${q}`),
    wantsReview ? api(`/api/issues/${item.issue}/review${q}`) : Promise.resolve(null),
  ]);
  state.thread = thread.status === "fulfilled" ? thread.value.issue : { error: thread.reason.message };
  if (wantsReview) state.review = review.status === "fulfilled" ? review.value : { error: review.reason.message };
  shell.render();
}

export async function actOn(item, action, text) {
  if (action === "cancel" && !confirm(`Cancel the run for #${item.issue}? This closes the issue.`)) return;
  try {
    await post(`/api/inbox/${item.issue}/act`, { action, text, repo: item.repo });
    clear();
    state.toast = `${ACTION_DONE[action]} for #${item.issue}`;
    await Promise.all([shell.loadInbox(), shell.loadView()]);
  } catch (e) {
    state.toast = e.message;
  }
  shell.render();
}

async function mergeApprove(item) {
  try {
    const r = await post(`/api/issues/${item.issue}/merge`, { repo: item.repo });
    if (r.decision.outcome !== "merge") {
      state.toast = `Not merged: ${r.decision.refusals.map((x) => x.detail).join("; ")}`;
      return shell.render();
    }
    clear();
    state.toast = `${ACTION_DONE.merge} #${item.issue}`;
    await Promise.all([shell.loadInbox(), shell.loadView()]);
  } catch (e) {
    state.toast = e.message;
  }
  shell.render();
}

function reviewPanel() {
  const r = state.review;
  if (!r) return quiet("Loading", "Reading the pull request.");
  if (r.error) return quiet("Could not load the review", r.error);
  const ciTone = r.ci.status === "passed" ? "ok" : r.ci.status === "failed" ? "bad" : "warn";
  const op = isOperator();
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
      r.gate ? [h("dt", null, "Gate"), h("dd", null, `${r.gate.status}, ${r.gate.line}`)] : null,
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
    op && r.stages.length
      ? table(
          ["Stage", "Agent", "Model", "Cost"],
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
          3,
        )
      : null,
  );
}

// The issue thread, with the factory's own comments marked as the bot's.
export function threadOf(t) {
  if (!t) return quiet("Loading", "Reading the issue thread.");
  if (t.error) return quiet("Could not load the thread", t.error);
  return h(
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
}

export function actionButtons(item, box) {
  return item.actions.map((a) =>
    h(
      "button",
      {
        class: `btn${a === "approve" || a === "answer" ? " btn-primary" : a === "cancel" ? " btn-danger" : ""}`,
        type: "button",
        onclick: () => {
          const text = box ? box.value : "";
          if (needsText(a) && !text.trim()) return box?.focus();
          actOn(item, a, text);
        },
      },
      actionLabel(item, a),
    ),
  );
}

function conversation(item) {
  const wantsText = item.actions.some(needsText);
  const box = wantsText
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
      h("h2", null, `#${item.issue} ${item.title} `, riskBadge(h, item.risk)),
      h(
        "span",
        { class: "muted" },
        `${short(item.repo)}, ${item.label.replace("factory:", "").replace(/-/g, " ")}, waiting ${age(item.waitingSince)}`,
      ),
      h("p", null, h("a", { href: `#/runs/${item.repo}/${item.issue}` }, "Open the run")),
    ),
    isReview ? h("div", { class: "panel-pad" }, reviewPanel()) : null,
    threadOf(state.thread),
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
        actionButtons(item, box),
      ),
    ),
  );
}

// The one tap: Approve plan on a plan, each listed choice on a question.
export function quickActions(item) {
  if (state.offline) return null;
  if (item.kind === "approve-plan" && item.actions.includes("approve"))
    return h(
      "div",
      { class: "quick" },
      h(
        "button",
        { class: "btn btn-primary", type: "button", onclick: () => actOn(item, "approve", "") },
        "Approve plan",
      ),
    );
  // The raw ask, since markdownText joins lines and the choices are one per line.
  const picks = item.kind === "answer-question" ? choicesOf(item.ask) : [];
  return picks.length
    ? h(
        "div",
        { class: "quick", role: "group", "aria-label": "Answer with one tap" },
        picks.map((p) =>
          h("button", { class: "btn chip", type: "button", onclick: () => actOn(item, "answer", p) }, p),
        ),
      )
    : null;
}

function inboxRow(i, multiRepo) {
  return h(
    "div",
    { class: "inbox-row", "aria-current": String(isSelected(i)) },
    h(
      "button",
      { class: "list-item", type: "button", disabled: state.offline, onclick: () => selectItem(i) },
      glyph(["failed", "budget"].includes(i.kind) ? "failed" : "waiting", KIND_LABEL[i.kind]),
      h(
        "span",
        { class: "li-main" },
        h("strong", null, `#${i.issue} ${i.title}`),
        h(
          "span",
          { class: "li-sub" },
          [KIND_LABEL[i.kind], multiRepo ? short(i.repo) : null].filter(Boolean).join(", "),
        ),
        h("span", { class: "li-ask" }, markdownText(i.ask).slice(0, 140)),
      ),
      h("span", { class: "li-time" }, age(i.waitingSince)),
    ),
    quickActions(i),
  );
}

export function inboxView() {
  const items = state.inbox.filter((i) => inRepo(i.repo));
  const item = items.find(isSelected);
  // Spend is operator detail, so the brief leaves it out for everyone else.
  const seen = state.offline ? state.relay.analytics : state.data.analytics;
  const analytics = isOperator() || !seen ? seen : { ...seen, spend7dUsd: 0 };
  return h(
    "section",
    null,
    heading("Inbox", execSummary(analytics, items)),
    state.offline
      ? h(
          "p",
          { class: "notice", role: "status" },
          "The dashboard is out of reach, so this list comes from the relay and is read-only. Act on the issue in your tracker.",
        )
      : null,
    !items.length
      ? quiet("Nothing is waiting on you", "Plans to approve and questions to answer show here.")
      : h(
          "div",
          { class: "split", "data-open": String(Boolean(item)) },
          h(
            "div",
            { class: "list-col" },
            h(
              "div",
              { class: "list" },
              items.map((i) => inboxRow(i, state.repos.length > 1)),
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
                        clear();
                        shell.render();
                      },
                    },
                    "Back to the inbox",
                  ),
                  conversation(item),
                ]
              : h(
                  "div",
                  { class: "empty-detail" },
                  svg(INBOX_ICON),
                  h(
                    "p",
                    null,
                    state.offline ? "Items open again when the dashboard is back" : "Select an item to read it",
                  ),
                ),
          ),
        ),
  );
}
