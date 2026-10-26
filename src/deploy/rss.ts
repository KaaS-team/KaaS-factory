// Resident memory of a process and everything under it. The idle budget is the goal idle-rss: plane
// plus relay, at rest, under 150 MB. tests/deploy.test.ts asserts it on a laptop and in CI, and the
// ci.yml docker job runs this file inside the built image against PID 1.
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const IDLE_RSS_BUDGET_MB = 150;

interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
}

// /proc where there is one (the slim image has no ps), ps elsewhere (macOS).
function processes(): Proc[] {
  if (existsSync("/proc/self/status")) {
    return readdirSync("/proc")
      .filter((d) => /^\d+$/.test(d))
      .flatMap((d) => {
        try {
          const status = readFileSync(`/proc/${d}/status`, "utf8");
          const field = (name: string) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
          return [{ pid: Number(d), ppid: field("PPid"), rssKb: field("VmRSS") }];
        } catch {
          return [];
        }
      });
  }
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss="]).stdout.toString();
  return out
    .trim()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .map(([pid, ppid, rssKb]) => ({ pid: pid!, ppid: ppid!, rssKb: rssKb! }));
}

export function treeRssKb(root: number): number {
  const all = processes();
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all)
      if (tree.has(p.ppid) && !tree.has(p.pid)) {
        tree.add(p.pid);
        grew = true;
      }
  }
  return all.filter((p) => tree.has(p.pid)).reduce((sum, p) => sum + p.rssKb, 0);
}

if (import.meta.main) {
  const root = Number(process.argv[2] ?? 1);
  const mb = treeRssKb(root) / 1024;
  console.log(`idle RSS of pid ${root} and its children: ${mb.toFixed(1)} MB (budget ${IDLE_RSS_BUDGET_MB} MB)`);
  process.exit(mb > 0 && mb < IDLE_RSS_BUDGET_MB ? 0 : 1);
}
