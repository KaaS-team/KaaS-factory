// Ported from owainlewis/assembler@7cac671 test/outputs.test.ts:112 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: only the escape-code assertion; the formatOutputs/formatRow parts are not ported.

import { expect, test } from "bun:test";
import { plain } from "../../../src/display";

test("terminal escape codes are removed", () => {
  const value = `\x1b[2J${"line\n".repeat(100)}`;
  expect(plain(value).includes("\x1b")).toBe(false);
});

test("other control characters are stripped and newlines and tabs survive", () => {
  expect(plain("a\x00b\x07c\x7fd\te\nf")).toBe("abcd\te\nf");
  expect(plain("\x1b]0;title\x07hello\x1b[31m red")).toBe("hello red");
});
