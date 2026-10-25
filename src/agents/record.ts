// Records an agent's raw stdout, scrubbed, so a participant's `factory verify-agent`
// run becomes a replayable fixture (tests/fixtures/agents/<name>/<stage>.jsonl).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEY_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD)/i;

// Env values that look like credentials are replaced wherever they appear, then well-known key shapes,
// then absolute paths under the home and worktree directories.
export function scrubLine(line: string, env: NodeJS.ProcessEnv, paths: readonly string[] = [homedir()]): string {
  let out = line;
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_ENV.test(key)) out = out.split(value).join("<redacted>");
  }
  out = out.replace(KEY_SHAPES, "<redacted>");
  for (const p of paths) {
    if (p.length <= 1) continue;
    out = out.split(p).join("<path>");
    // Claude names its project dirs by turning every "/" and "." of the path into "-".
    out = out.split(p.replace(/[/.]/g, "-")).join("<path>");
  }
  return out;
}

export class FixtureRecorder {
  constructor(
    private readonly dir: string,
    agent: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly paths: readonly string[] = [homedir()],
  ) {
    mkdirSync(dir, { recursive: true });
    // Keep extra keys (Cursor's reportsUsage: false); a recording is never synthetic.
    const path = join(dir, "fixture.json");
    const prior = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
    writeFileSync(path, `${JSON.stringify({ ...prior, agent, synthetic: false }, null, 2)}\n`);
  }

  // The first line of a stage replaces any file already there (a synthetic fixture), later lines append.
  private readonly started = new Set<string>();

  line(stage: string, raw: string): void {
    if (!raw.trim()) return;
    const file = join(this.dir, `${stage}.jsonl`);
    const scrubbed = `${scrubLine(raw, this.env, this.paths)}\n`;
    if (this.started.has(stage)) appendFileSync(file, scrubbed);
    else {
      this.started.add(stage);
      writeFileSync(file, scrubbed);
    }
  }
}
