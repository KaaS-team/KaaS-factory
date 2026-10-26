// The change failure rate history lives in the state DB, so a fresh process keeps the tightened limits.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config";
import { mergeContext, mergeHistory, rememberMerge } from "../src/merge-autonomy";
import { FactoryState } from "../src/state";

test("a new FactoryState opened on the same file still sees the history and keeps the tightened limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "merge-history-"));
  const db = join(dir, "state.db");
  const config = {
    repo: "o/r",
    merge: { policy: "auto", autonomy: "full", maxFiles: 10, maxLines: 200 },
  } as unknown as FactoryConfig;
  const github = { listIssuesByLabel: async () => [], currentLogin: async () => "bot", roleOf: async () => "admin" };

  const first = new FactoryState(db);
  for (let i = 0; i < 10; i++) rememberMerge(first, "o/r", i < 2);
  first.close();

  const second = new FactoryState(db);
  expect(mergeHistory(second, "o/r").filter((m) => m.reverted)).toHaveLength(2);
  expect(mergeHistory(second, "other/repo")).toEqual([]);
  const ctx = await mergeContext({ github: github as never, state: second }, config, dir, 1, [], 1);
  expect(ctx?.mode).toBe("full");
  expect(ctx?.merge).toMatchObject({ maxFiles: 5, maxLines: 100 });
  second.close();
});
