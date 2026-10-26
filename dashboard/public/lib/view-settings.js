// Settings as tabs, one panel per topic. Runtimes and leases name hosts, so they are operator tabs;
// the automation switches are the owner's to flip and everyone else's to read.

import {
  api,
  focusRepo,
  h,
  heading,
  isOperator,
  money,
  post,
  quiet,
  repoQuery,
  shell,
  state,
  stateOr,
  table,
} from "./core.js";
import { readRelay, saveRelay } from "./relay-follow.js";
import { enablePush } from "./remote.js";
import { healthCell, leasesPanel, machinesPanel, slotsText } from "./settings.js";

const isOwner = () => state.me?.role === "owner";

export const SETTINGS_TABS = [
  ["general", "General", () => true],
  ["automation", "Automation", () => true],
  ["runtimes", "Runtimes", isOperator],
  ["leases", "Leases", isOperator],
  ["phone", "Phone", () => true],
];
export const settingsTabs = () => SETTINGS_TABS.filter(([, , can]) => can());

const SWITCHES = [
  ["auto_start", "Start new issues automatically", "An issue marked ready starts without anyone pressing a button."],
  [
    "auto_approve_low_risk",
    "Approve low-risk plans",
    "A plan the factory rates low risk goes ahead without waiting for you.",
  ],
];

export async function loadToggles() {
  state.data.toggles = "loading";
  state.data.toggles = await api(`/api/toggles${repoQuery()}`).catch(() => null);
  shell.render();
}

function general(d) {
  return h(
    "dl",
    { class: "kv" },
    h("dt", null, "Runs at once"),
    h("dd", null, slotsText(d)),
    isOperator()
      ? [h("dt", null, "Daily spend cap"), h("dd", null, d.dailyUsd == null ? "None set" : money(d.dailyUsd))]
      : null,
    d.integrations?.on.length
      ? [
          h("dt", null, `${d.integrations.on.join(", ")} act on`),
          h("dd", null, d.integrations.repo || "Nothing yet: this plane has no default project, so they are off"),
        ]
      : null,
  );
}

function automation() {
  const t = state.data.toggles;
  if (t === undefined) loadToggles();
  if (t === undefined || t === "loading") return quiet("Loading", "Reading the switches.");
  if (!t) return quiet("Could not read the switches", "Reload the page to try again.");
  return h(
    "div",
    { class: "switches" },
    isOwner() ? null : h("p", { class: "muted" }, "Only an owner can change these."),
    SWITCHES.map(([key, label, hint]) =>
      h(
        "label",
        { class: "toggle switch-row" },
        h("input", {
          type: "checkbox",
          id: `toggle-${key}`,
          checked: Boolean(t[key]),
          disabled: !isOwner(),
          onchange: async (e) => {
            const value = e.target.checked;
            try {
              await post("/api/toggles", { key, value, repo: focusRepo() || undefined });
              t[key] = value;
              state.toast = `${label}: ${value ? "on" : "off"}`;
            } catch (err) {
              e.target.checked = !value;
              state.toast = err.message;
            }
            shell.render();
          },
        }),
        h("span", null, h("strong", null, label), h("span", { class: "muted" }, hint)),
      ),
    ),
  );
}

function runtimes(d) {
  return table(
    ["Runtime", "Kind", "Target", "Used by", "Health"],
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
        h("td", null, r.usedBy.length ? r.usedBy.join(", ") : "Nothing in this project"),
        healthCell(d.health[r.name], h),
      ),
    ),
  );
}

function leases(d) {
  return h(
    "div",
    null,
    h("h3", null, "Machines"),
    machinesPanel(d, h),
    h("h3", null, "Issue leases"),
    leasesPanel(d, h, quiet),
  );
}

const phone = () => h("div", null, relayForm(), pushPanel());

function pushPanel() {
  const button = h("button", { class: "btn", type: "button" }, "Turn on notifications");
  button.onclick = async () => {
    button.disabled = true;
    const ok = await enablePush().catch(() => false);
    button.textContent = ok ? "Notifications are on" : "This browser cannot take notifications";
  };
  return h(
    "section",
    null,
    h("h3", null, "This phone"),
    h("p", { class: "muted" }, "Get a notification when the factory needs you or finishes a task."),
    button,
  );
}

function relayForm() {
  const cfg = readRelay(localStorage);
  return h(
    "form",
    {
      class: "relay-form",
      onsubmit: (e) => {
        e.preventDefault();
        const f = e.target;
        const url = f.relayUrl.value.trim();
        const token = f.relayToken.value.trim();
        const saved = saveRelay(localStorage, url && token ? { url, token, channel: "inbox" } : null);
        f.querySelector(".hint").textContent = !saved
          ? "This browser does not keep settings, so the relay is off."
          : url && token
            ? "Relay saved. This browser now follows the relay."
            : "Relay cleared. This browser no longer follows a relay.";
        shell.startFollowing();
      },
    },
    h(
      "p",
      { class: "muted" },
      "With a relay set, this browser keeps the inbox up to date when the dashboard is out of reach. Saved in this browser only.",
    ),
    h("label", { class: "muted", for: "relayUrl" }, "Relay address"),
    h("input", { class: "field-control", id: "relayUrl", name: "relayUrl", type: "url", value: cfg?.url ?? "" }),
    h("label", { class: "muted", for: "relayToken" }, "Read token"),
    h("input", {
      class: "field-control",
      id: "relayToken",
      name: "relayToken",
      type: "password",
      autocomplete: "off",
      value: cfg?.token ?? "",
    }),
    h("p", { class: "hint muted", role: "status" }),
    h("button", { class: "btn", type: "submit" }, "Save relay"),
  );
}

const PANELS = { general, automation, runtimes, leases, phone };

export function settingsView() {
  const tabs = settingsTabs();
  const current = tabs.some(([id]) => id === state.settingsTab) ? state.settingsTab : "general";
  const needsData = current !== "automation" && current !== "phone";
  return h(
    "section",
    null,
    heading("Settings", "How the factory runs for this project."),
    h(
      "div",
      { class: "tabs", role: "tablist", "aria-label": "Settings topics" },
      tabs.map(([id, label]) =>
        h(
          "button",
          {
            class: "tab",
            type: "button",
            role: "tab",
            id: `settings-${id}`,
            "aria-selected": String(id === current),
            "aria-controls": "settings-panel",
            onclick: () => {
              state.settingsTab = id;
              shell.render();
            },
          },
          label,
        ),
      ),
    ),
    h(
      "div",
      {
        class: "panel panel-pad settings-panel",
        id: "settings-panel",
        role: "tabpanel",
        "aria-labelledby": `settings-${current}`,
      },
      needsData
        ? stateOr("settings", (d) => (!d.available ? quiet("No project to read", d.reason) : PANELS[current](d)))
        : PANELS[current](),
    ),
  );
}
