// A test that falls back to the real ~/.factory would read whatever repos ran on this machine.
// Every temp dir a test or the code under it makes lands in one root, removed when the run ends (#270).
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "factory-test-"));
process.env.TMPDIR = root;
process.env.FACTORY_HOME = join(root, "home");
mkdirSync(process.env.FACTORY_HOME);
delete process.env.FACTORY_REPOS;
afterAll(() => rmSync(root, { recursive: true, force: true }));
