// A test that falls back to the real ~/.factory would read whatever repos ran on this machine.
// Every temp dir a test or the code under it makes lands in one root, removed after the process exits (#270).
// afterAll runs after each rerun under --rerun-each, so it empties the root and recreates it instead of
// deleting it: the next run finds a usable TMPDIR and FACTORY_HOME and tests need no mkdirSync(tmpdir()) (#622).
import { afterAll } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun test --parallel evaluates this preload again for every file in a fresh realm of the same worker, with
// globalThis and process.env reset, so a watcher per evaluation piled up about fifty shells per worker in a
// full run. The disk is the one state the evaluations share: the root is named by the pid, and only
// the evaluation that creates it spawns the watcher. A child bun has another pid and makes its own root.
mkdirSync(tmpdir(), { recursive: true });
const root = join(tmpdir(), `factory-test-${process.pid}`);
let fresh = true;
try {
  mkdirSync(root);
} catch {
  fresh = false;
}
const home = join(root, "home");
process.env.TMPDIR = root;
process.env.FACTORY_HOME = home;
mkdirSync(home, { recursive: true });
delete process.env.FACTORY_REPOS;
afterAll(() => {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(home);
});
// bun test runs no exit handler from a preload, and afterAll cannot tell the last rerun from another,
// so a detached watcher removes the root once this process is gone.
if (fresh) {
  const watch = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$2"';
  Bun.spawn(["sh", "-c", watch, "sh", String(process.pid), root], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
