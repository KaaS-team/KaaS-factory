// Structural: the cockpit's design system stays whole. Modelled on machinist
// visual-system.test.js: one light theme as on kaas.team (contrast is tests/tokens.test.ts),
// the mobile bottom nav is in place, and every view goes through the shared heading. Also pins
// the rule that page code never renders server text as HTML.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "dashboard", "public");
const css = readFileSync(join(dir, "styles.css"), "utf8");
const tokensCss = readFileSync(join(dir, "tokens.css"), "utf8");
const html = readFileSync(join(dir, "index.html"), "utf8");
// The page code is the shell plus one module per view, so every rule below reads all of it.
const app = [
  join(dir, "app.js"),
  ...readdirSync(join(dir, "lib"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(dir, "lib", f)),
]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("visual system", () => {
  test("one light theme, as on kaas.team: no dark variant and no theme switch", () => {
    expect(tokensCss).toContain("color-scheme:light");
    for (const f of [tokensCss, css, html, app]) expect(f).not.toMatch(/data-theme|prefers-color-scheme/);
  });

  test("mobile navigation is a bottom bar with safe-area padding", () => {
    expect(css).toMatch(/\.app-sidebar nav \{ position: fixed;[^}]*bottom: 0;/);
    expect(css).toMatch(/\.app-sidebar nav \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;/);
    expect(css).toContain("padding-bottom: calc(4.15rem + env(safe-area-inset-bottom))");
  });

  test("motion is reduced on request and focus is always visible", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain(":focus-visible");
  });

  test("Geist ships with its licence, and every file the CSS names exists", () => {
    const named = [...css.matchAll(/url\("\/(fonts\/[\w-]+\.woff2)"\)/g)].map((m) => m[1]!);
    expect(named).toEqual(["fonts/geist.woff2"]);
    for (const f of named) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(readFileSync(join(dir, "fonts", "LICENSE-geist.txt"), "utf8")).toContain(
      "SIL Open Font License, Version 1.1",
    );
  });

  test("every top-level view is built with the shared heading", () => {
    for (const view of [
      "lineView",
      "inboxView",
      "runsView",
      "workflowsView",
      "analyticsView",
      "agentsView",
      "settingsView",
      "boardView",
    ]) {
      const at = app.indexOf(`function ${view}(`);
      expect(at, view).toBeGreaterThan(-1);
      const body = app.slice(at);
      expect(body.slice(0, body.indexOf("\n}\n")), view).toMatch(/heading\(/);
    }
  });

  test("server text never reaches innerHTML, and labels are not all-caps", () => {
    expect(app).not.toMatch(/\.(innerHTML|outerHTML)\b|insertAdjacentHTML/);
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
  });
});
