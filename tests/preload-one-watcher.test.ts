import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// bun test --parallel evaluates the preload once per file inside one worker. A watcher spawned on each
// evaluation piled up about fifty shells per worker, so six files on two workers must leave one each.
test("a parallel run keeps one root watcher per worker", () => {
  const dir = join(import.meta.dir, "fixtures", "preload-watch");
  const files = readdirSync(dir).map((f) => join(dir, f));
  expect(files.length).toBe(6);
  const proc = Bun.spawnSync(
    ["bun", "test", "--parallel=2", "--preload", join(import.meta.dir, "preload.ts"), ...files],
    { timeout: 60_000 },
  );
  const out = proc.stdout.toString() + proc.stderr.toString();
  const seen = [...out.matchAll(/WATCHERS (\d+)/g)].map((m) => Number(m[1]));
  expect(seen.length).toBe(6);
  expect(Math.max(...seen)).toBe(1);
});
