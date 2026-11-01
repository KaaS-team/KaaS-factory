import { appendFileSync } from "node:fs";

// Every process a step starts is recorded as a child of the step. Cancel signals them all,
// waits, escalates, and reports what survived. A child outlives its step only when released.

export interface TreeReport {
  readonly ended: readonly number[];
  readonly survivors: readonly number[];
}

interface Row {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly zombie: boolean;
}

const steps = new Map<string, { root: number; children: Set<number>; released: Set<number> }>();

function table(): Row[] {
  const out = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,pgid=,stat="]).stdout.toString();
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
    if (pid && ppid && pgid) rows.push({ pid: +pid, ppid: +ppid, pgid: +pgid, zombie: stat?.startsWith("Z") ?? false });
  }
  return rows;
}

// Everything under `root` by parent link or by process group, which setsid children alone escape.
function descendants(root: number, rows: readonly Row[]): number[] {
  const found = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.pid === root || found.has(r.pid)) continue;
      if (r.pgid === root || r.ppid === root || found.has(r.ppid)) {
        found.add(r.pid);
        grew = true;
      }
    }
  }
  return [...found];
}

// Record the children alive now. Call while the step runs: a child orphaned later is still known.
export function recordChildren(stepId: string): readonly number[] {
  const s = steps.get(stepId);
  if (!s) return [];
  for (const pid of descendants(s.root, table())) if (!s.released.has(pid)) s.children.add(pid);
  return [...s.children];
}

export interface StepTree {
  // Kills what is left, notes any survivor in the transcript; one run per step.
  reap(transcript: string | undefined, label: string): void;
  record(): void;
  stop(): Promise<void>;
}

// Starts recording the step's children every 500 ms.
export function trackStep(stepId: string, rootPid: number): StepTree {
  steps.set(stepId, { root: rootPid, children: new Set(), released: new Set() });
  const timer = setInterval(() => recordChildren(stepId), 500);
  timer.unref();
  let reaped: Promise<void> | undefined;
  return {
    record: () => void recordChildren(stepId),
    reap(transcript, label) {
      reaped ??= terminate(stepId, 0).then((r) => {
        const line = survivorLine(r);
        if (line && transcript) appendFileSync(transcript, `=== ${label} ${line} ===\n`);
      });
    },
    async stop() {
      await reaped;
      clearInterval(timer);
      steps.delete(stepId);
    },
  };
}

// The step says this child may outlive it.
export function release(stepId: string, pid: number): void {
  const s = steps.get(stepId);
  s?.children.delete(pid);
  s?.released.add(pid);
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // ESRCH: already gone, which is the goal.
  }
}

function alive(pids: readonly number[]): number[] {
  const live = new Set(
    table()
      .filter((r) => !r.zombie)
      .map((r) => r.pid),
  );
  return pids.filter((p) => live.has(p));
}

async function waitGone(pids: readonly number[], ms: number): Promise<number[]> {
  const until = Date.now() + ms;
  let left = alive(pids);
  while (left.length > 0 && Date.now() < until) {
    await Bun.sleep(20);
    left = alive(left);
  }
  return left;
}

export async function terminate(stepId: string, graceMs: number): Promise<TreeReport> {
  const s = steps.get(stepId);
  if (!s) return { ended: [], survivors: [] };
  recordChildren(stepId);
  const all = [s.root, ...s.children];
  for (const p of all) signal(p, "SIGTERM");
  let left = await waitGone(all, graceMs);
  if (left.length > 0) {
    for (const p of recordChildren(stepId)) if (!all.includes(p)) all.push(p);
    for (const p of alive(all)) signal(p, "SIGKILL");
    left = await waitGone(left, 1000);
  }
  steps.delete(stepId);
  return { ended: all.filter((p) => !left.includes(p)), survivors: left };
}

export function survivorLine(r: TreeReport): string | undefined {
  return r.survivors.length > 0 ? `still running after cancel: pid ${r.survivors.join(", ")}` : undefined;
}
