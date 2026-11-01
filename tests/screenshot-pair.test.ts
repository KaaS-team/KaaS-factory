import { describe, expect, test } from "bun:test";
import { renderShotPairs, screenshotSection, visibleRoutes } from "../src/screenshot-pair.js";

describe("visibleRoutes", () => {
  test("reads routes from page files", () => {
    expect(visibleRoutes(["app/settings/page.tsx", "pages/index.tsx", "pages/about.vue"])).toEqual([
      "/",
      "/about",
      "/settings",
    ]);
  });
  test("layout, loading, error and not-found files name no route", () => {
    expect(
      visibleRoutes(["app/layout.tsx", "app/loading.tsx", "app/x/error.tsx", "app/not-found.tsx", "app/x/layout.tsx"]),
    ).toEqual([]);
  });
  test("a route with a [param] segment is skipped", () => {
    expect(visibleRoutes(["app/[id]/page.tsx", "app/a/[...slug]/page.tsx"])).toEqual([]);
  });
  test("(group) segments are dropped", () => {
    expect(visibleRoutes(["app/(auth)/login/page.tsx", "app/(m)/(n)/page.tsx"])).toEqual(["/", "/login"]);
  });
  test("non-UI and non-route files name no route", () => {
    expect(visibleRoutes(["src/engine/pr-body.ts", "components/Button.tsx", "app/api/x.ts", "README.md"])).toEqual([]);
  });
});

describe("renderShotPairs", () => {
  test("renders before and after side by side", () => {
    expect(renderShotPairs([{ route: "/a", before: "b.png", after: "a.png" }])).toBe(
      "| Route | Before | After |\n| --- | --- | --- |\n| `/a` | ![](b.png) | ![](a.png) |",
    );
  });
  test("empty for no routes", () => {
    expect(renderShotPairs([])).toBe("");
  });
  test("a missing before shows as none", () => {
    expect(renderShotPairs([{ route: "/n", before: "", after: "a.png" }])).toContain("| _none_ | ![](a.png) |");
  });
});

describe("screenshotSection", () => {
  test("captures base and head per route", async () => {
    const calls: string[] = [];
    const out = await screenshotSection(["app/x/page.tsx"], async (r, ref) => {
      calls.push(`${ref}:${r}`);
      return `${ref}.png`;
    });
    expect(calls).toEqual(["base:/x", "head:/x"]);
    expect(out).toContain("![](base.png) | ![](head.png)");
  });
  test("a non-UI change captures nothing", async () => {
    let n = 0;
    const out = await screenshotSection(["src/a.ts"], async () => {
      n++;
      return "x";
    });
    expect(out).toBe("");
    expect(n).toBe(0);
  });
});
