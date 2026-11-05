// A test that falls back to the real ~/.factory would read whatever repos ran on this machine.
// Every temp dir a test or the code under it makes lands in one root, removed after the process exits (#270).
// afterAll runs after each rerun under --rerun-each, so it empties the root and recreates it instead of
// deleting it: the next run finds a usable TMPDIR and FACTORY_HOME and tests need no mkdirSync(tmpdir()) (#622).
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "factory-test-"));
const home = join(root, "home");
process.env.TMPDIR = root;
process.env.FACTORY_HOME = home;
mkdirSync(home);
delete process.env.FACTORY_REPOS;
afterAll(() => {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true });
  mkdirSync(home);
});
// bun test runs no exit handler from a preload, and afterAll cannot tell the last rerun from another,
// so a detached watcher removes the root once this process is gone.
Bun.spawn(
  ["sh", "-c", 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf -- "$2"', "sh", String(process.pid), root],
  {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  },
).unref();
