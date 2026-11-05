import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a temp dir can be made on every rerun", () => {
  expect(mkdtempSync(join(tmpdir(), "rerun-"))).toContain("rerun-");
});
