// `up --tmux` forwards --port to the dashboard window (#41), the dashboard moves off a taken
// default port but never off an explicit one (#159), and --help never starts a long-running
// command (#616).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DASHBOARD_DEFAULT_PORT, listenOnFreePort } from "../src/dashboard-port";
import { upWindows } from "../src/tmux";

const bin = join(import.meta.dir, "..", "bin", "factory");

describe("up --tmux windows (#41)", () => {
  test("the dashboard window receives --port", () => {
    const w = upWindows("factory", "/r", { port: "4200" });
    expect(w.dashboard).toContain("--port '4200'");
  });

  test("the watcher window does not get --port", () => {
    const w = upWindows("factory", "/r", { port: "4200", db: "x.db" });
    expect(w.watch).toBe("factory watch --repo-dir '/r' --tmux --db 'x.db'");
    expect(w.dashboard).toBe("factory dashboard --repo-dir '/r' --db 'x.db' --port '4200'");
  });

  test("no port, no --port", () => {
    expect(upWindows("factory", "/r", {}).dashboard).not.toContain("--port");
  });
});

describe("dashboard port (#159)", () => {
  const busy =
    (...taken: number[]) =>
    (p: number) => {
      if (taken.includes(p))
        throw Object.assign(new Error("Failed to start server. Is port in use?"), { code: "EADDRINUSE" });
      return `server:${p}`;
    };

  test("a free default is used", () => {
    expect(listenOnFreePort(undefined, busy()).port).toBe(DASHBOARD_DEFAULT_PORT);
  });

  test("a taken default moves to the next free port", () => {
    const r = listenOnFreePort(undefined, busy(DASHBOARD_DEFAULT_PORT, DASHBOARD_DEFAULT_PORT + 1));
    expect(r.port).toBe(DASHBOARD_DEFAULT_PORT + 2);
    expect(r.server).toBe(`server:${DASHBOARD_DEFAULT_PORT + 2}`);
  });

  test("a taken explicit port fails with one line naming it", () => {
    expect(() => listenOnFreePort(4300, busy(4300))).toThrow("dashboard: port 4300 is already in use");
  });

  test("an explicit port never moves", () => {
    const tried: number[] = [];
    expect(() =>
      listenOnFreePort(4300, (p) => {
        tried.push(p);
        return busy(4300)(p);
      }),
    ).toThrow();
    expect(tried).toEqual([4300]);
  });

  test("other bind errors are not swallowed", () => {
    expect(() =>
      listenOnFreePort(undefined, () => {
        throw new Error("EACCES");
      }),
    ).toThrow("EACCES");
  });
});

describe("--help starts nothing (#616)", () => {
  for (const cmd of ["up", "watch", "dashboard", "serve", "daemon", "runner", "mcp", "pair"]) {
    for (const flag of ["--help", "-h"]) {
      test(`${cmd} ${flag} prints usage and exits`, async () => {
        const proc = Bun.spawn(["bun", bin, cmd, flag, "--repo-dir", "/nonexistent"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const timer = setTimeout(() => proc.kill(), 8000);
        const out = await new Response(proc.stdout).text();
        const code = await proc.exited;
        clearTimeout(timer);
        expect(code).toBe(0);
        expect(out).toContain("factory <command>");
      }, 15000);
    }
  }
});
