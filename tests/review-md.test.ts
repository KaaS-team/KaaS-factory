import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextPack } from "../src/context";
import { installTemplate } from "../src/install-template";

function tmp(): string {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), "factory-review-"));
}

describe("root REVIEW.md", () => {
  test("is folded into the conventions section of every stage that reads conventions", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "REVIEW.md"), "Reject any diff that touches billing.\n");
    for (const stage of ["triage", "plan", "build", "verify"] as const) {
      const pack = await buildContextPack(stage, 1, cwd);
      expect(pack).toContain("Reject any diff that touches billing.");
    }
    expect(await buildContextPack("pr", 1, cwd)).not.toContain("billing");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("an empty REVIEW.md adds nothing", async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "REVIEW.md"), "  \n");
    expect(await buildContextPack("build", 1, cwd)).toBe("");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("init seeds REVIEW.md and update keeps the repo's edits", () => {
    const cwd = tmp();
    installTemplate(cwd);
    expect(existsSync(join(cwd, "REVIEW.md"))).toBe(true);
    writeFileSync(join(cwd, "REVIEW.md"), "Mine.\n");
    installTemplate(cwd, { update: true });
    expect(readFileSync(join(cwd, "REVIEW.md"), "utf8")).toBe("Mine.\n");
    rmSync(cwd, { recursive: true, force: true });
  });
});
