// The run page's pieces: the agent's activity as cards and the proof a reviewer reads.
// Items come from /api/issues/:n/live, the same parse `factory view` draws in the
// terminal, so the page and the tmux window never disagree.

import { inline, renderMarkdown, toDom } from "/lib/markdown.js";
// Re-exported so app.js takes the task badge with the other page pieces, in one import.
export { riskBadge } from "/lib/risk-badge.js";

const VERB = {
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
  MultiEdit: "Edited",
  Bash: "Ran",
  Grep: "Searched for",
  Glob: "Looked for",
  Agent: "Handed off",
  Task: "Handed off",
  Skill: "Used the skill",
  WebFetch: "Fetched",
  WebSearch: "Searched the web for",
};
const STAGE_NAME = { triage: "Triage", plan: "Plan", build: "Build", verify: "Verify", pr: "Pull request" };

export const stageName = (s) => STAGE_NAME[s] ?? s;
export const toolSentence = (name, target) => `${VERB[name] ?? name}${target ? ` ${target}` : ""}`;

function seconds(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function diffBlock(d, h) {
  const side = (rows, more, sign) => [
    ...rows.map((r) => h("span", { class: `diff-${sign === "+" ? "add" : "del"}` }, `${sign} ${r}`)),
    more ? h("span", { class: "muted" }, `${more} more lines`) : null,
  ];
  return h("pre", { class: "card-diff" }, side(d.removed, d.removedMore, "-"), side(d.added, d.addedMore, "+"));
}

// A new file shows its opening lines; the run's own records under .factory/ show no body,
// since each one reaches GitHub as a comment.
const NEW_FILE_LINES = 8;
const shortNew = (d) => ({
  ...d,
  added: d.added.slice(0, NEW_FILE_LINES),
  addedMore: d.addedMore + Math.max(0, d.added.length - NEW_FILE_LINES),
});

// A test or gate run reads as its verdict first; the lines that decided it follow. Output
// with no verdict in it (a file listing, a grep) stays folded so the feed reads as steps.
function resultCard(item, h) {
  const failed = item.rows.some((r) => r.tone === "fail");
  const passed = !failed && item.rows.some((r) => r.tone === "pass");
  const rows = h(
    "pre",
    null,
    item.rows.map((r) => h("span", { "data-tone": r.tone }, r.text)),
  );
  if (!failed && !passed)
    return h(
      "details",
      { class: "card result", "data-tone": "plain", "data-nested": item.nested },
      h("summary", { class: "result-head" }, item.ok ? "Output" : "The command exited with an error"),
      rows,
    );
  return h(
    "div",
    { class: "card result", "data-tone": failed ? "fail" : "pass", "data-nested": item.nested },
    h("span", { class: "result-head" }, failed ? "Failed" : "Passed"),
    rows,
  );
}

export function feedCard(item, h) {
  switch (item.kind) {
    case "stage":
      return h("div", { class: "card stage", "data-stage": item.stage }, h("span", null, stageName(item.stage)));
    case "exit":
      return h(
        "div",
        { class: "card exit", "data-tone": item.ok ? "pass" : "fail" },
        item.ok
          ? `${stageName(item.stage)} finished`
          : `${stageName(item.stage)} stopped${item.reason ? `: ${item.reason}` : ` with exit code ${item.code}`}`,
      );
    case "say":
      return h("div", { class: "card say", "data-nested": item.nested }, renderMarkdown(item.text, h));
    case "tool":
      return h(
        "div",
        { class: "card tool", "data-tool": item.name, "data-nested": item.nested },
        h(
          "span",
          { class: "tool-line" },
          ...inline(toolSentence(item.name, item.target ? `\`${item.target.replace(/`/g, "'")}\`` : "")).map((n) =>
            toDom(n, h),
          ),
        ),
        item.diff && !item.target.startsWith(".factory/")
          ? diffBlock(item.name === "Write" ? shortNew(item.diff) : item.diff, h)
          : null,
      );
    case "result":
      return resultCard(item, h);
    case "done":
      return h(
        "div",
        { class: "card done muted" },
        [
          item.ms != null ? `Took ${seconds(item.ms)}` : "Done",
          item.costUsd != null ? `$${item.costUsd.toFixed(2)}` : null,
        ]
          .filter(Boolean)
          .join(", "),
      );
    default:
      return h("div", { class: "card raw muted" }, item.text);
  }
}

const MARK = { pass: "✓", fail: "✗" };

function section(title, h, ...kids) {
  return h("section", { class: "proof-part" }, h("h3", null, title), ...kids);
}

export function proofPanel(p, h) {
  if (!p) return h("p", { class: "muted" }, "Reading the proof.");
  if (!p.criteria.length && !p.gate && !p.revert && !p.holdout && !p.result)
    return h("p", { class: "muted" }, "The proof fills in as the plan is approved and build and verify finish.");
  const md = (text) => inline(text).map((n) => toDom(n, h));
  return h(
    "div",
    { class: "proof" },
    p.criteria.length
      ? section(
          "Acceptance criteria",
          h,
          h(
            "ul",
            { class: "criteria" },
            p.criteria.map((c) =>
              h(
                "li",
                { "data-tone": c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "plain" },
                h("span", { class: "mark", "aria-label": c.status }, MARK[c.status] ?? "○"),
                h(
                  "div",
                  null,
                  h("strong", null, c.id),
                  " ",
                  ...md(c.what),
                  c.check ? h("div", { class: "muted" }, "Checked by ", ...md(c.check)) : null,
                ),
              ),
            ),
          ),
        )
      : null,
    p.gate
      ? section(
          "Gates",
          h,
          h(
            "p",
            { "data-tone": p.gate.failed ? "fail" : "pass" },
            `${p.gate.passed} passed, ${p.gate.failed} failed${p.gate.skipped ? `, ${p.gate.skipped} skipped` : ""}`,
          ),
          p.gate.nonBlocking.length
            ? h("p", { class: "muted" }, `Not blocking: ${p.gate.nonBlocking.join(", ")}`)
            : null,
        )
      : null,
    p.holdout
      ? section(
          "Tests the build never saw",
          h,
          p.holdout.ok
            ? h(
                "p",
                { "data-tone": "pass" },
                `${p.holdout.passed ? `${p.holdout.passed} holdout tests` : "The holdout tests"} passed. The build agent could not read or change them.`,
              )
            : h(
                "p",
                { "data-tone": "fail" },
                "The holdout tests failed, so the work went back to build with the failing test names.",
              ),
          p.holdout.failedTests.length
            ? h(
                "ul",
                { class: "failed-tests" },
                p.holdout.failedTests.map((t) => h("li", null, t)),
              )
            : null,
        )
      : null,
    p.revert
      ? section(
          "Does the test catch the bug?",
          h,
          p.revert.status === "bites"
            ? h(
                "p",
                { "data-tone": "pass" },
                "The fix was reverted and the new test failed, so the test catches the bug.",
              )
            : h("p", { "data-tone": "fail" }, `The revert check did not prove the test (${p.revert.status}).`),
          p.revert.reverted.length
            ? h("p", { class: "muted" }, "Reverted ", ...md(p.revert.reverted.map((f) => `\`${f}\``).join(", ")))
            : null,
          p.revert.failedTests.length
            ? h(
                "ul",
                { class: "failed-tests" },
                p.revert.failedTests.map((t) => h("li", null, t)),
              )
            : null,
        )
      : null,
    p.result
      ? section(
          "Verify",
          h,
          h(
            "p",
            { "data-tone": p.result === "pass" ? "pass" : "fail" },
            p.result === "pass"
              ? "A separate session checked every criterion and passed the change."
              : `Verify returned ${p.result}.`,
          ),
          p.findings.length
            ? h(
                "div",
                null,
                h("h4", null, "Reviewer's suggestion"),
                h(
                  "ul",
                  { class: "findings" },
                  p.findings.map((f) => h("li", null, ...md(f.fix || f.what))),
                ),
              )
            : null,
        )
      : null,
  );
}
