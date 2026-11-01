import { describe, expect, test } from "bun:test";
import { ROUTES } from "../src/api/routes";
import { ROUTE_SCOPES, SCOPES, scopeAllows, scopeOf, undeclaredRoutes } from "../src/route-scopes";

describe("route scopes", () => {
  test("every route declares one known scope", () => {
    expect(undeclaredRoutes()).toEqual([]);
    for (const route of ROUTES) expect(SCOPES).toContain(scopeOf(route));
  });

  test("no scope is declared for a route that does not exist", () => {
    expect(Object.keys(ROUTE_SCOPES).sort()).toEqual(ROUTES.map((r) => r.id).sort());
  });

  test("a route that mutates needs edit-structure", () => {
    for (const route of ROUTES.filter((r) => r.method !== "GET")) expect(scopeOf(route)).toBe("edit-structure");
  });

  test("a route with no declared scope throws", () => {
    expect(() => scopeOf({ id: "nope" })).toThrow("declares no scope");
  });

  test("the two scopes are independent", () => {
    const read = ROUTES.find((r) => r.id === "runs.list")!;
    expect(scopeAllows(["read-act"], read)).toBe(true);
    expect(scopeAllows(["edit-structure"], read)).toBe(false);
    expect(scopeAllows([], read)).toBe(false);
    expect(scopeAllows(["admin"], read)).toBe(false);
  });
});
