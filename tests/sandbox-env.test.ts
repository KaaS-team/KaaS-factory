// The sandbox env list: exact names only, tied to what the sandbox reads.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "../src/agents/presets";
import { forwardSettings, looksLikeCredential, SANDBOX_SETTINGS } from "../src/sandbox-env";

const root = join(import.meta.dir, "..");
const sandboxScripts = [
  ...readdirSync(join(root, "template/.claude/hooks"))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => join(root, "template/.claude/hooks", f)),
  join(root, "template/.factory/qa.sh"),
];

const readInSandbox = new Set<string>();
for (const file of sandboxScripts)
  for (const m of readFileSync(file, "utf8").matchAll(/\bFACTORY_[A-Z][A-Z_]*/g)) readInSandbox.add(m[0]);
const presetEnv = new Set<string>(Object.values(PRESETS).flatMap((p) => Object.keys(p.env ?? {})));
const listed: readonly string[] = SANDBOX_SETTINGS;

describe("sandbox settings list", () => {
  test("every setting the sandbox scripts read is listed", () => {
    expect([...readInSandbox].filter((n) => !listed.includes(n))).toEqual([]);
  });

  test("every listed name is read by a sandbox script or set by a preset", () => {
    expect(listed.filter((n) => !readInSandbox.has(n) && !presetEnv.has(n))).toEqual([]);
  });

  test("the list has no duplicates", () => {
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("a name that is not listed is dropped, even with the FACTORY_ prefix", () => {
    const out = forwardSettings({ FACTORY_STAGE: "build", FACTORY_API_TOKEN: "not-a-placeholder", STRAY: "1" });
    expect(out).toEqual({ FACTORY_STAGE: "build" });
  });

  test("a credential-shaped name with a real-looking value is refused", () => {
    expect(() => forwardSettings({ FACTORY_X_TOKEN: "not-a-placeholder" }, ["FACTORY_X_TOKEN"])).toThrow(
      "FACTORY_X_TOKEN looks like a credential",
    );
  });

  test("a credential-shaped name with a placeholder passes", () => {
    expect(forwardSettings({ FACTORY_X_TOKEN: "placeholder" }, ["FACTORY_X_TOKEN"])).toEqual({
      FACTORY_X_TOKEN: "placeholder",
    });
  });

  test("the credential words are recognised by suffix only", () => {
    expect(["A_API_KEY", "B_SECRET", "C_TOKEN"].every(looksLikeCredential)).toBe(true);
    expect(["FACTORY_ISSUE", "KEYBOARD_MODE"].some(looksLikeCredential)).toBe(false);
  });

  test("no listed name needs a real value", () => {
    expect(listed.filter(looksLikeCredential)).toEqual([]);
  });

  test("the executor passes the guest env through forwardSettings", () => {
    const src = readFileSync(join(root, "src/agents/executor.ts"), "utf8");
    expect(src.includes("...forwardSettings(stageEnv)")).toBe(true);
  });
});
