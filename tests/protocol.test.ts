import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atLeast, COMMANDS, isRole, ROLES } from "@kaas-team/factory-protocol";

const DIR = resolve(import.meta.dir, "../packages/protocol");

describe("protocol package", () => {
  test("roles rise viewer < approver < operator < owner", () => {
    expect([...ROLES]).toEqual(["viewer", "approver", "operator", "owner"]);
    for (let i = 0; i < ROLES.length; i++)
      for (let j = 0; j < ROLES.length; j++) expect(atLeast(ROLES[i]!, ROLES[j]!)).toBe(i >= j);
    expect(isRole("owner")).toBe(true);
    expect(isRole("root")).toBe(false);
  });

  test("every command has a known role and one of five actions", () => {
    const actions = ["approve", "revise", "answer", "retry", "cancel"];
    expect(Object.keys(COMMANDS).sort()).toEqual(["answer", "approve-plan", "cancel", "retry", "revise"]);
    for (const c of Object.values(COMMANDS)) {
      expect(isRole(c.role)).toBe(true);
      expect(actions).toContain(c.action);
    }
    expect(COMMANDS["approve-plan"]?.role).toBe("approver");
  });

  test("the package imports nothing from src/ or dashboard/", () => {
    expect(readFileSync(join(DIR, "index.ts"), "utf8")).not.toMatch(/from\s+["'][^"']*(src|dashboard)\//);
  });

  test("the package is private and named for the scope", () => {
    const pkg = JSON.parse(readFileSync(join(DIR, "package.json"), "utf8"));
    expect(pkg.name).toBe("@kaas-team/factory-protocol");
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("Apache-2.0");
  });
});
