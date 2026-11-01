import { describe, expect, test } from "bun:test";
import { redact, scanText } from "../src/secret-scan";

// Built at run time so no secret-shaped literal sits in the repo.
const up = "ABCDEFGHIJKLMNOP";
const mid = "abcdefghijklmnopqrstuvwx";
const keys: Record<string, string> = {
  "aws-access-key-id": "AK" + "IA" + up,
  "github-token": "gh" + "p_" + mid,
  "anthropic-key": "sk-" + "ant-" + mid,
  "slack-token": "xo" + "xb-" + "1234567890-abcdef",
  "private-key": "-----BEGIN " + "RSA PRIVATE" + " KEY-----",
};

describe("secret scan", () => {
  for (const [rule, key] of Object.entries(keys)) {
    test(`${rule} is found and the value never is`, () => {
      const hits = scanText(`line one\nvalue ${key} here`);
      expect(hits).toEqual([{ rule, line: 2 }]);
      expect(JSON.stringify(hits)).not.toContain(key);
    });
  }

  test("prose and a 40-char git sha are clean", () => {
    const sha = "0123456789abcdef".repeat(2) + "01234567";
    expect(scanText(`Fixes the token parser. commit ${sha}\nsk-learn is a library`)).toEqual([]);
  });

  test("redact removes the value", () => {
    const out = redact(`a ${keys["github-token"]} b ${keys["aws-access-key-id"]}`);
    expect(out).toBe("a [REDACTED] b [REDACTED]");
  });
});
