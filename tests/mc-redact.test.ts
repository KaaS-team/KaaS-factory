import { describe, expect, test } from "bun:test";
import { redactRow, redactText } from "../src/mc/redact";

const SHAPES: Record<string, string> = {
  bearer: "Bearer abcdef0123456789xyz",
  basic: "Basic dXNlcjpwYXNzd29yZA==",
  ghp: `ghp_${"a1B2".repeat(6)}`,
  gho: `gho_${"a1B2".repeat(6)}`,
  githubPat: `github_pat_${"A1b2".repeat(8)}`,
  sk: `sk-${"abcd1234".repeat(3)}`,
  skAnt: `sk-ant-${"abcd1234".repeat(3)}`,
  akia: "AKIAABCDEFGHIJKLMNOP",
  slack: "xoxb-1234567890-abcdefghij",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
  userinfo: "https://bob:hunter2pass@example.com/x",
  token: "https://x.test/a?token=zzz111",
  accessToken: "https://x.test/a?z=1&access_token=zzz111",
  key: "https://x.test/a?key=zzz111",
  apiKey: "https://x.test/a?api_key=zzz111",
  secret: "https://x.test/a?secret=zzz111",
  sig: "https://x.test/a?sig=zzz111",
  signature: "https://x.test/a?signature=zzz111",
  code: "https://x.test/a?code=zzz111",
  auth: "https://x.test/a?auth=zzz111",
};

describe("redactText", () => {
  for (const [name, sample] of Object.entries(SHAPES)) {
    test(`${name} is redacted inside a sentence`, () => {
      const out = redactText(`The error said ${sample} and then it stopped.`);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain(sample);
      expect(out).toStartWith("The error said ");
      expect(out).toEndWith(" and then it stopped.");
    });
  }

  test("a known value is redacted wherever it appears", () => {
    const secret = "hunter2-long-value";
    const out = redactText(`a ${secret} b ${secret}/c x=${secret}`, [secret]);
    expect(out).not.toContain(secret);
    expect(out.match(/\[redacted\]/g)?.length).toBe(3);
  });

  test("a known value under 8 characters is left alone", () => {
    expect(redactText("a short one", ["short"])).toBe("a short one");
  });

  test("a commit sha and a plain issue URL survive", () => {
    const text = `fixed in ${"a".repeat(20)}${"1b2c3d4e5f".repeat(2)} see https://github.com/o/r/issues/12`;
    expect(redactText(text)).toBe(text);
  });
});

describe("redactRow", () => {
  test("redacts every string field, nested", () => {
    const row = { id: 1, title: "t Bearer abcdef0123456789xyz", nested: { list: ["k-secret-value-1", "ok"] } };
    const out = redactRow(row, ["k-secret-value-1"]);
    expect(JSON.stringify(out)).not.toContain("abcdef0123456789xyz");
    expect(JSON.stringify(out)).not.toContain("k-secret-value-1");
    expect(out.id).toBe(1);
    expect(out.nested.list[1]).toBe("ok");
  });
});
