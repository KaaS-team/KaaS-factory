// Ported from owainlewis/machinist@3943516 internal/controlplane/web/src/routes.js:1-end (MIT, Copyright (c) 2026 Owain Lewis). Deviations: the page set is the factory's views (inbox, line, runs, workflows, analytics, agents, settings) and a run detail route is #/runs/<issue number>.
const pages = new Set(["inbox", "line", "runs", "workflows", "analytics", "agents", "settings"]);

export function routeFromHash(hash) {
  const value = hash.replace(/^#\//, "");
  if (value.startsWith("runs/")) {
    if (!value.slice(5)) return { view: "runs", jobID: "" };
    try {
      return { view: "task", jobID: decodeURIComponent(value.slice(5)) };
    } catch {
      return { view: "runs", jobID: "" };
    }
  }
  return { view: pages.has(value) ? value : "inbox", jobID: "" };
}
