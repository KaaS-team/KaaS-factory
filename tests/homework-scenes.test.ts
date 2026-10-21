// Every drawing on the homework pages fits: no label spills its box, no arrow crosses a node, no
// edge names a missing node. The pages also never number themselves, because the series gets
// reordered: no "week one", no "Assignment 2", no week-1 file name.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "teach", "worksheets", "homework");
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));

// scene.js is a browser script that also hands its pure half to CommonJS; the repo is ESM, so load it by hand.
const scene = (() => {
  const mod = { exports: {} as { check: (spec: unknown) => string[] } };
  new Function("module", readFileSync(join(dir, "scene.js"), "utf8"))(mod);
  return mod.exports;
})();

const SPEC = /<script type="application\/json" class="scene">([\s\S]*?)<\/script>/g;
const FIGURE = /<figure class="scene"[^>]*>([\s\S]*?)<\/figure>/g;

test("the homework folder has pages", () => {
  expect(pages.length).toBeGreaterThan(0);
});

for (const page of pages) {
  const html = readFileSync(join(dir, page), "utf8");

  test(`${page}: every scene passes the layout check`, () => {
    const problems: string[] = [];
    const specs = [...html.matchAll(SPEC)];
    expect(specs.length).toBeGreaterThan(0);
    for (const [i, m] of specs.entries()) {
      for (const p of scene.check(JSON.parse(m[1] ?? ""))) problems.push(`scene ${i + 1}: ${p}`);
    }
    expect(problems).toEqual([]);
  });

  test(`${page}: every scene carries its narration`, () => {
    for (const m of html.matchAll(FIGURE)) expect(m[1]).toContain('<ol class="narr">');
  });

  test(`${page}: no ordinal labels`, () => {
    expect(page).not.toMatch(/week-?\d|assignment-?\d/i);
    const text = html.replace(/<[^>]+>/g, " ");
    expect(text.match(/\b(weeks? (one|two|three|four|\d)|assignment \d|next week|last week|this week)\b/gi) ?? []).toEqual([]);
  });
}
