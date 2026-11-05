import { test } from "bun:test";

// Counts the root watchers this worker has spawned so far; tests/preload-one-watcher.test.ts reads the line.
test("count watchers", () => {
  const ps = Bun.spawnSync(["ps", "-ax", "-o", "ppid=,command="], { timeout: 5000 }).stdout.toString();
  const mine = ps.split("\n").filter((l) => l.trim().startsWith(`${process.pid} `) && l.includes("do sleep 0.2"));
  console.log(`WATCHERS ${mine.length}`);
});
