// Runs a test command and kills it when one test runs longer than the limit, naming the file, the test and the time.
// Bun's own timeout cannot stop a blocked event loop, or a test that sets a long timeout of its own.
// Usage: bun scripts/test-watchdog.ts --limit <seconds> -- <command...>
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Hung {
  pid: number;
  file: string;
  name: string;
  seconds: number;
}

export function findHung(dir: string, now: number, limitMs: number): Hung[] {
  const out: Hung[] = [];
  for (const f of readdirSync(dir)) {
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as { file: string; name: string; start: number };
      if (now - m.start > limitMs)
        out.push({
          pid: Number.parseInt(f, 10),
          file: m.file,
          name: m.name,
          seconds: Math.round((now - m.start) / 1000),
        });
    } catch {
      // a marker removed or half written between the listing and the read is a test that just ended
    }
  }
  return out;
}

export function hungLine(h: Hung, limitSeconds: number, root: string): string {
  const file = h.file.startsWith(`${root}/`) ? h.file.slice(root.length + 1) : h.file;
  return `HUNG: ${file} > ${h.name} ran ${h.seconds}s, over the ${limitSeconds}s limit; killed`;
}

async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf("--");
  const li = argv.indexOf("--limit");
  const limit = Number(argv[li + 1]);
  if (dash < 0 || li < 0 || !(limit > 0)) {
    console.error("usage: test-watchdog.ts --limit <seconds> -- <command...>");
    return 2;
  }
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-hang-"));
  const proc = Bun.spawn(argv.slice(dash + 1), {
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
    env: { ...process.env, FACTORY_HANG_DIR: dir },
  });
  let killed = false;
  const poll = setInterval(
    () => {
      const hung = findHung(dir, Date.now(), limit * 1000);
      if (hung.length === 0) return;
      killed = true;
      for (const h of hung) console.error(hungLine(h, limit, process.cwd()));
      for (const f of readdirSync(dir)) {
        try {
          process.kill(Number.parseInt(f, 10), "SIGKILL");
        } catch {
          // already gone
        }
      }
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    },
    Math.min(1000, limit * 250),
  );
  const code = await proc.exited;
  clearInterval(poll);
  rmSync(dir, { recursive: true, force: true });
  return killed ? 124 : code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
