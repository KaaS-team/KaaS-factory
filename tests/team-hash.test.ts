// The config hash is the same for the same values in any key order, and moves with any leaf.
import { describe, expect, test } from "bun:test";
import { configHash } from "../src/team/hash";

describe("config hash", () => {
  const a = { model: "sonnet", policy: { models: ["a", "b"], auto_merge: { allowed: false } }, token_env: "GH_TOKEN" };

  test("key order at any depth does not matter", () => {
    const b = {
      token_env: "GH_TOKEN",
      policy: { auto_merge: { allowed: false }, models: ["a", "b"] },
      model: "sonnet",
    };
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("one changed leaf changes it, and list order is kept", () => {
    expect(configHash({ ...a, model: "haiku" })).not.toBe(configHash(a));
    expect(configHash({ ...a, policy: { ...a.policy, models: ["b", "a"] } })).not.toBe(configHash(a));
  });

  test("an env var value never reaches it, only the name", () => {
    const before = configHash(a);
    process.env.GH_TOKEN = "ghp_secret_value";
    expect(configHash(a)).toBe(before);
    delete process.env.GH_TOKEN;
  });
});
