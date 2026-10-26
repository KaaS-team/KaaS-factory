// A test that falls back to the real ~/.factory would read whatever repos ran on this machine.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-home-"));
delete process.env.FACTORY_REPOS;
