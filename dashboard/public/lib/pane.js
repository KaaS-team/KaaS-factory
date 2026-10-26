// The run page's right pane, one tab per question a reviewer asks: did it do what was asked
// (Outcome), what changed, did the checks pass, what does it look like, how risky is it, and,
// for an operator only, what it cost.

import { h, isOperator, money, quiet, shell, state, statusText } from "./core.js";

export const PANE_TABS = [
  ["outcome", "Outcome"],
  ["changes", "Changes"],
  ["checks", "Checks"],
  ["preview", "Preview"],
  ["risk", "Risk"],
  ["cost", "Cost"],
];
export const paneTabs = (me = state.me) => PANE_TABS.filter(([id]) => id !== "cost" || isOperator(me));

const STATUS_WORDS = { pass: "Passed", fail: "Failed", pending: "Not checked yet" };

// A criterion reads as Given, When, Then when it is written that way; otherwise it stays one sentence.
export function gwt(what) {
  const m = /^\s*given\s+(.+?),?\s+when\s+(.+?),?\s+then\s+(.+)$/i.exec(what);
  return m
    ? [
        ["Given", m[1]],
        ["When", m[2]],
        ["Then", m[3]],
      ]
    : [["Then", what]];
}

// Counts added and removed lines of a unified diff, skipping the file headers.
export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  const files = [];
  for (const line of (diff || "").split("\n")) {
    if (line.startsWith("+++ ")) files.push(line.replace(/^\+\+\+ (b\/)?/, ""));
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed, files };
}

function outcome(proof) {
  if (!proof?.criteria?.length)
    return quiet("No acceptance checklist yet", "It appears once the plan is approved and lists what done means.");
  return h(
    "ul",
    { class: "outcome" },
    proof.criteria.map((c) =>
      h(
        "li",
        { "data-tone": c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "plain" },
        h(
          "span",
          { class: "status", "data-tone": c.status === "pass" ? "ok" : c.status === "fail" ? "bad" : "" },
          STATUS_WORDS[c.status] ?? statusText(c.status),
        ),
        h(
          "dl",
          { class: "gwt" },
          gwt(c.what).map(([k, v]) => [h("dt", null, k), h("dd", null, v)]),
        ),
      ),
    ),
  );
}

// Clicking a changed line drops a quote of it into the composer, so the comment becomes the next message.
function changes(review, onComment) {
  if (!review) return quiet("No changes yet", "The diff shows once the run opens a pull request.");
  if (review.error) return quiet("No pull request yet", "The diff shows once the run opens one.");
  const { added, removed, files } = diffStats(review.diff);
  return h(
    "div",
    null,
    h(
      "p",
      { class: "diff-stat" },
      h("span", { "data-tone": "pass" }, `+${added}`),
      " ",
      h("span", { "data-tone": "fail" }, `-${removed}`),
      ` in ${files.length} ${files.length === 1 ? "file" : "files"}`,
    ),
    h(
      "pre",
      { class: "diff pane-diff", "aria-label": "Changes. Pick a line to comment on it." },
      (review.diff || "").split("\n").map((line, i) =>
        h(
          "button",
          {
            class: "diff-line",
            type: "button",
            "data-sign": /^(\+\+\+|---) /.test(line) ? "" : line[0] === "+" ? "add" : line[0] === "-" ? "del" : "",
            title: "Comment on this line",
            onclick: () => onComment(`> ${line}\n\n`),
            "data-n": i,
          },
          line || " ",
        ),
      ),
    ),
  );
}

function checks(proof, review) {
  const rows = [];
  if (proof?.gate)
    rows.push([
      "Project checks",
      proof.gate.failed ? "bad" : "ok",
      `${proof.gate.passed} passed, ${proof.gate.failed} failed`,
    ]);
  if (review?.ci)
    rows.push([
      "CI",
      review.ci.status === "passed" ? "ok" : review.ci.status === "failed" ? "bad" : "warn",
      statusText(review.ci.status),
    ]);
  if (proof?.holdout)
    rows.push(["Tests the build never saw", proof.holdout.ok ? "ok" : "bad", proof.holdout.ok ? "Passed" : "Failed"]);
  if (proof?.revert)
    rows.push([
      "The new test catches the bug",
      proof.revert.status === "bites" ? "ok" : "bad",
      proof.revert.status === "bites" ? "Yes" : "Not proven",
    ]);
  if (proof?.result)
    rows.push([
      "Separate review",
      proof.result === "pass" ? "ok" : "bad",
      proof.result === "pass" ? "Passed" : statusText(proof.result),
    ]);
  if (!rows.length) return quiet("No checks have run yet", "They run after the build.");
  return h(
    "dl",
    { class: "kv checks" },
    rows.map(([k, t, v]) => [h("dt", null, k), h("dd", null, h("span", { class: "status", "data-tone": t }, v))]),
  );
}

function preview(pane) {
  const p = pane?.preview;
  const link = p?.prUrl
    ? h("p", null, h("a", { href: p.prUrl, target: "_blank", rel: "noreferrer" }, "Open the pull request"))
    : null;
  if (!p?.shots?.length)
    return h(
      "div",
      null,
      quiet("No screenshots for this run", "A run that changes a page takes one per screen size."),
      link,
    );
  return h(
    "div",
    null,
    p.pairs.length ? h("p", null, `Before and after at ${p.pairs.join(", ")}, so you can verify the fix.`) : null,
    h(
      "ul",
      { class: "plain-list" },
      p.shots.map((s) => h("li", null, [s.state, s.viewport, s.theme].filter(Boolean).join(", "))),
    ),
    h("p", { class: "muted" }, "The images are in the pull request."),
    link,
  );
}

function risk(pane) {
  if (!pane) return quiet("Reading the risk", "");
  const { level, signals } = pane.risk;
  return h(
    "div",
    null,
    h(
      "p",
      null,
      h(
        "span",
        {
          class: "status",
          "data-tone": level === "high" ? "bad" : level === "medium" ? "warn" : level === "low" ? "ok" : "",
        },
        level === "unknown" ? "Not rated yet" : `${level[0].toUpperCase()}${level.slice(1)} risk`,
      ),
    ),
    signals.length
      ? h(
          "ul",
          { class: "plain-list signals" },
          signals.map((s) => h("li", null, s)),
        )
      : null,
  );
}

function cost(pane) {
  if (!pane?.cost) return quiet("No cost recorded", "");
  return h(
    "div",
    null,
    h("p", null, `${money(pane.cost.totalUsd)} for this run`),
    h(
      "dl",
      { class: "kv" },
      pane.cost.stages.map((s) => [
        h("dt", null, `${s.stage}, ${s.agent}`),
        h("dd", null, `${s.model}, ${money(s.costUsd)}`),
      ]),
    ),
  );
}

export function rightPane({ tab, proof, review, pane, onTab, onComment }) {
  const tabs = paneTabs();
  const current = tabs.some(([id]) => id === tab) ? tab : "outcome";
  const body = {
    outcome: () => outcome(proof),
    changes: () => changes(review, onComment),
    checks: () => checks(proof, review),
    preview: () => preview(pane),
    risk: () => risk(pane),
    cost: () => cost(pane),
  }[current];
  return h(
    "aside",
    { class: "panel run-pane" },
    h(
      "div",
      { class: "pane-tabs", role: "tablist", "aria-label": "About this run" },
      tabs.map(([id, label]) =>
        h(
          "button",
          {
            class: "pane-tab",
            type: "button",
            role: "tab",
            id: `tab-${id}`,
            "aria-selected": String(id === current),
            "aria-controls": "pane-body",
            onclick: () => (onTab ?? (() => shell.render()))(id),
          },
          label,
        ),
      ),
    ),
    h(
      "div",
      { class: "pane-body panel-pad", id: "pane-body", role: "tabpanel", "aria-labelledby": `tab-${current}` },
      body(),
    ),
  );
}
