// A before and after screenshot pair for the PR body of a UI change. Pure: the capture function is
// injected, so nothing here launches a browser. Only renderShotPairs is called in production (by the PR
// body builder, src/engine/pr-body.ts). visibleRoutes and screenshotSection have no caller yet.

export type ShotPair = { route: string; before: string; after: string };
export type Capture = (route: string, ref: "base" | "head") => Promise<string>;

const PAGE_FILE = /\.(tsx|jsx|vue|svelte|astro|html)$/;

// Routes a diff visibly changes, read from page-file paths only. Shared components and styles name
// no route, so they yield none: a guess would put a wrong image in the PR body.
export function visibleRoutes(paths: readonly string[]): string[] {
  const routes = new Set<string>();
  for (const p of paths) {
    if (!PAGE_FILE.test(p)) continue;
    const m = /(?:^|\/)(?:app|pages|dashboard\/public)\/(.+)$/.exec(p);
    if (!m) continue;
    const stem = (m[1] ?? "").replace(PAGE_FILE, "");
    if (/(^|\/)(layout|loading|error|not-found)$/.test(stem)) continue;
    const r = stem.replace(/(^|\/)(page|index)$/, "");
    if (/(^|\/)(_|api\/)/.test(r) || r.startsWith("api/")) continue;
    const segs = r.split("/").filter((x) => x !== "" && !/^\(.*\)$/.test(x));
    if (segs.some((x) => x.includes("["))) continue;
    routes.add(`/${segs.join("/")}`);
  }
  return [...routes].sort();
}

const cell = (ref: string) => (ref === "" ? "_none_" : `![](${ref})`);

// Side by side table, one row per route. Empty string when there is no route to show.
export function renderShotPairs(pairs: readonly ShotPair[]): string {
  if (pairs.length === 0) return "";
  const rows = pairs.map((p) => `| \`${p.route}\` | ${cell(p.before)} | ${cell(p.after)} |`);
  return ["| Route | Before | After |", "| --- | --- | --- |", ...rows].join("\n");
}

// Capture each touched route on base and head, then render. No visible route, no capture calls.
export async function screenshotSection(paths: readonly string[], capture: Capture): Promise<string> {
  const pairs: ShotPair[] = [];
  for (const route of visibleRoutes(paths)) {
    pairs.push({ route, before: await capture(route, "base"), after: await capture(route, "head") });
  }
  return renderShotPairs(pairs);
}
