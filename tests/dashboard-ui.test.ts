// The cockpit's views, rendered against a tiny fake document: the page code only ever calls
// createElement, setAttribute, append and addEventListener (lib/core.js h()), so this is enough to
// read what a QA lead or PM would see, and to press its buttons, without a browser.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBoard } from "../dashboard/board";
import { paneView } from "../dashboard/pane";
import type { GhIssue } from "../src/github";

type Kid = El | string;
class El {
  tag: string;
  attrs: Record<string, string> = {};
  kids: Kid[] = [];
  listeners: Record<string, ((e: unknown) => unknown)[]> = {};
  className = "";
  value = "";
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  get id() {
    return this.attrs.id ?? "";
  }
  get disabled() {
    return "disabled" in this.attrs;
  }
  append(...kids: Kid[]) {
    this.kids.push(...kids);
  }
  replaceChildren(...kids: Kid[]) {
    this.kids = kids;
  }
  addEventListener(type: string, fn: (e: unknown) => unknown) {
    (this.listeners[type] ||= []).push(fn);
  }
  focus() {}
  get textContent(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
  }
  async click() {
    for (const fn of this.listeners.click ?? []) await fn({ preventDefault() {}, target: this });
  }
  all(pred: (e: El) => boolean): El[] {
    const out: El[] = [];
    const walk = (e: El) => {
      if (pred(e)) out.push(e);
      for (const k of e.kids) if (typeof k !== "string") walk(k);
    };
    walk(this);
    return out;
  }
  byClass(c: string) {
    return this.all((e) => e.className.split(" ").includes(c));
  }
  byText(tag: string, text: string) {
    return this.all((e) => e.tag === tag && e.textContent === text);
  }
}

const posts: { path: string; body: unknown }[] = [];
Object.assign(globalThis, {
  document: {
    createElement: (t: string) => new El(t),
    createElementNS: (_ns: string, t: string) => new El(t),
    getElementById: () => null,
    activeElement: null,
  },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  confirm: () => true,
});
// Only the dashboard's own relative paths are faked, and the real fetch comes back after this file:
// bun runs every test file in one process, so a leaked stub answers later files' local servers.
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
globalThis.fetch = (async (path: string, init?: { body?: string }) => {
  if (/^https?:/.test(String(path))) return realFetch(path, init as RequestInit);
  if (init?.body) posts.push({ path, body: JSON.parse(init.body) });
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;

const lib = "../dashboard/public/lib";
const { state, shell } = await import(`${lib}/core.js`);
const { runView, live, stageGroups } = await import(`${lib}/view-run.js`);
const { quickActions } = await import(`${lib}/view-inbox.js`);
const { settingsView } = await import(`${lib}/view-settings.js`);
const { workflowsView } = await import(`${lib}/view-workflows.js`);
const { boardColumns } = await import(`${lib}/view-board.js`);
const { createSendQueue } = await import(`${lib}/actions.js`);
const { taskComposer } = await import(`${lib}/view-line.js`);
Object.assign(shell, { render() {}, go() {}, async loadInbox() {}, async loadView() {}, startFollowing() {} });

const css = readFileSync(join(import.meta.dir, "..", "dashboard", "public", "styles.css"), "utf8");
const html = readFileSync(join(import.meta.dir, "..", "dashboard", "public", "index.html"), "utf8");
const as = (role: string) => (state.me = { role });

const planItem = {
  issue: 7,
  repo: "acme/shop",
  title: "Fix the cart total",
  kind: "approve-plan",
  actions: ["approve", "revise", "cancel"],
  ask: "Approve the plan?",
  waitingSince: new Date().toISOString(),
};

function openRun() {
  state.repo = "acme/shop";
  state.route = { view: "task", jobID: "acme/shop/7" };
  state.inbox = [planItem];
  state.data.line = { rows: [] };
  Object.assign(live, {
    key: "acme/shop#7",
    items: [
      { kind: "stage", stage: "plan" },
      { kind: "tool", tool: "Read", summary: "src/cart.ts" },
      { kind: "exit", stage: "plan", ok: true },
      { kind: "stage", stage: "build" },
      { kind: "tool", tool: "Edit", summary: "src/cart.ts" },
    ],
    tab: "outcome",
    open: {},
  });
  return runView() as El;
}

beforeEach(() => {
  posts.length = 0;
  state.offline = false;
  state.toast = "";
  state.data = {};
  state.error = {};
  as("viewer");
});

describe("cockpit for QA and PMs", () => {
  test("the run page puts Outcome, Changes, Checks, Preview and Risk beside the timeline, and Cost only for an operator", () => {
    const tabsOf = (page: El) =>
      page
        .byClass("run-pane")[0]!
        .byClass("pane-tab")
        .map((t) => t.textContent);
    const viewer = openRun();
    expect(viewer.byClass("run-grid")[0]!.kids.length).toBe(2);
    expect(tabsOf(viewer)).toEqual(["Outcome", "Changes", "Checks", "Preview", "Risk"]);
    live.proof = { criteria: [{ status: "pass", what: "Given a 10% code, When I pay, Then the total is 90" }] };
    const terms = openRun()
      .byClass("gwt")[0]!
      .all((e) => e.tag === "dt" || e.tag === "dd");
    expect(terms.map((e) => e.textContent)).toEqual([
      "Given",
      "a 10% code",
      "When",
      "I pay",
      "Then",
      "the total is 90",
    ]);
    live.proof = null;
    as("operator");
    expect(tabsOf(openRun())).toEqual(["Outcome", "Changes", "Checks", "Preview", "Risk", "Cost"]);
    // The server leaves cost and model names out of the pane for anyone below operator.
    const input = { stages: [{ stage: "build", agent: "claude", model: "secret-model", cost_usd: 1.2 }] };
    expect(paneView(input, false).cost).toBeNull();
    expect(paneView(input, true).cost?.totalUsd).toBe(1.2);
  });

  test("a run reads as a conversation: stages fold like tool calls, the plan card approves, and a sent message can be undone", async () => {
    expect(stageGroups(live.items).map((g: { stage: string }) => g.stage)).toEqual(["plan", "build"]);
    const page = openRun();
    const folds = page.byClass("fold");
    expect(folds.map((f) => f.tag)).toEqual(["details", "details"]);
    expect("open" in folds[0]!.attrs).toBe(false);
    expect("open" in folds[1]!.attrs).toBe(true);
    await page.byClass("plan-card")[0]!.byText("button", "Approve plan")[0]!.click();
    expect(posts).toEqual([{ path: "/api/inbox/7/act", body: { action: "approve", text: "", repo: "acme/shop" } }]);
    expect(state.toast).toBe("Plan approved for #7");

    const sent: unknown[] = [];
    const timers = { setTimeout: (fn: () => void) => fn as unknown as number, clearTimeout() {} };
    const q = createSendQueue({ send: (m: unknown) => sent.push(m), timers });
    const entry = q.enqueue({ text: "use the new total" });
    expect(q.items.length).toBe(1);
    q.undo(entry);
    expect(q.items.length).toBe(0);
    expect(sent).toEqual([]);
  });

  test("on a phone the cockpit is one column with bottom tabs, and an inbox row approves or answers in one tap", async () => {
    const phone = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(phone).toMatch(/\.app-sidebar nav \{ position: fixed;[^}]*bottom: 0;/);
    expect(phone).toMatch(/\.rail-list, \.rail-task \{ display: none; \}/);
    expect(css).toMatch(
      /@media \(max-width: 1023px\) \{[^@]*\.run-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/,
    );

    await (quickActions(planItem) as El).byText("button", "Approve plan")[0]!.click();
    expect(posts.at(-1)).toEqual({
      path: "/api/inbox/7/act",
      body: { action: "approve", text: "", repo: "acme/shop" },
    });
    const question = {
      ...planItem,
      kind: "answer-question",
      actions: ["answer"],
      ask: "Which total?\n\n- Before tax\n- After tax",
    };
    const chips = (quickActions(question) as El).byClass("chip");
    expect(chips.map((c) => c.textContent)).toEqual(["Before tax", "After tax"]);
    await chips[1]!.click();
    expect(posts.at(-1)?.body).toEqual({ action: "answer", text: "After tax", repo: "acme/shop" });
    expect(state.toast).toBe("Answer sent for #7");
  });

  test("with two projects the composer starts on no project and will not submit until one is picked", () => {
    Object.assign(state, { repos: ["acme/shop", "acme/blog"], repo: "", repoFilter: "" });
    const pick = (taskComposer() as El).all((e) => e.id === "task-repo")[0]!;
    expect("required" in pick.attrs).toBe(true);
    const options = pick.all((e) => e.tag === "option");
    expect(options.filter((o) => "selected" in o.attrs).map((o) => o.attrs.value)).toEqual([""]);
    state.repoFilter = "acme/blog";
    const filtered = (taskComposer() as El).all((e) => e.tag === "option" && "selected" in e.attrs);
    expect(filtered.map((o) => o.attrs.value)).toEqual(["acme/blog"]);
    state.repoFilter = "";
  });

  test("Settings is tabs, one panel per topic", async () => {
    state.data.settings = { available: true, slots: 2, dailyUsd: 5, runtimes: [], leases: [] };
    const tabs = (page: El) => page.all((e) => e.attrs.role === "tab").map((t) => t.textContent);
    const page = settingsView() as El;
    expect(tabs(page)).toEqual(["General", "Automation", "Phone"]);
    expect(page.all((e) => e.attrs.role === "tabpanel").length).toBe(1);
    expect(page.byClass("settings-panel")[0]!.textContent).not.toContain("Daily spend cap");
    as("operator");
    expect(tabs(settingsView() as El)).toEqual(["General", "Automation", "Runtimes", "Leases", "Phone"]);
    await (settingsView() as El).byText("button", "Phone")[0]!.click();
    const phone = settingsView() as El;
    expect(phone.byText("button", "Phone")[0]!.attrs["aria-selected"]).toBe("true");
    expect(phone.byClass("settings-panel")[0]!.byText("button", "Save relay").length).toBe(1);
    state.settingsTab = "general";
    state.data.settings = { available: true, slots: 2, integrations: { repo: "acme/shop", on: ["Slack", "A2A"] } };
    expect((settingsView() as El).byClass("settings-panel")[0]!.textContent).toContain("Slack, A2A act onacme/shop");
  });

  test("a workflow reads as plain steps for a PM, and its automation switches are one click away", async () => {
    state.data.workflows = {
      available: true,
      problems: [],
      workflows: [
        {
          name: "bugfix",
          source: "repo",
          routedTypes: ["bug"],
          cron: [],
          problems: [],
          steps: [
            { id: "triage", uses: "triage" },
            { id: "plan", uses: "plan" },
            { id: "build", uses: "build", runtime: "local" },
          ],
        },
      ],
    };
    const page = workflowsView() as El;
    const steps = page.byClass("flow")[0]!.kids as El[];
    expect(steps.map((s) => s.tag)).toEqual(["li", "li", "li"]);
    expect(steps[1]!.textContent).toContain("Waits for you");
    expect(page.textContent).toContain("Issues marked as");
    expect(page.byClass("tech").length).toBe(0);
    await page.byText("a", "Change what runs automatically")[0]!.click();
    expect(state.settingsTab).toBe("automation");
    state.data.toggles = { auto_start: true, auto_approve_low_risk: false };
    const switches = (settingsView() as El).byClass("switch-row").map((s) => s.textContent);
    expect(switches[0]).toContain("Start new issues automatically");
    expect(switches[1]).toContain("Approve low-risk plans");
    state.settingsTab = "general";
  });

  test("an issue on a custom workflow step gets its own board column, not only the list", () => {
    const gh = (number: number, labels: string[]): GhIssue => ({
      number,
      title: `Issue ${number}`,
      body: "",
      labels: labels.map((name) => ({ name })),
      comments: [],
    });
    const cards = buildBoard([gh(1, ["factory:linting"]), gh(2, ["factory:building"])]);
    expect(cards[0]).toMatchObject({ column: "step", step: "linting" });
    const cols = boardColumns(cards);
    const linting = cols.find((c: { id: string }) => c.id === "step:linting");
    expect(linting.title).toBe("Linting");
    expect(linting.cards.map((c: { issue: number }) => c.issue)).toEqual([1]);
    expect(cols.map((c: { id: string }) => c.id).indexOf("step:linting")).toBe(5);
  });

  test("the dashboard wears the kaas.team look: Geist, the kaas tokens, the inset frame and pill tabs", () => {
    expect(html.indexOf('href="/tokens.css"')).toBeLessThan(html.indexOf('href="/styles.css"'));
    expect(html).toContain('<div class="frame">');
    expect(css).toMatch(/\.frame \{[^}]*border-radius: 12px;[^}]*box-shadow: var\(--ring\);/);
    expect(css).toContain("font-family: var(--sans)");
    // A selected tab, in Settings or beside a run, is the same raised pill kaas.team uses.
    expect(css).toContain(
      '.tab[aria-selected="true"] { color: var(--ink); background: var(--surface); box-shadow: var(--lift); }',
    );
    const p7 = css.slice(css.indexOf("/* P7:"), css.indexOf("@media (max-width: 1180px)"));
    expect(p7.length).toBeGreaterThan(0);
    expect(p7).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
