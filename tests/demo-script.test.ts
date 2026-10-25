// teach/demo/lightning-2.sh builds the lesson's tmux layout and screenshots it. --dry-run prints
// every tmux command, so the layout is checked without a tmux server; snap.ts is checked on a known ANSI sample.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactoryState } from "../src/state";
import { ansiToHtml, renderPage } from "../teach/demo/snap";

const root = join(import.meta.dir, "..");
const script = join(root, "teach/demo/lightning-2.sh");
const dry = (...args: string[]) => {
  const p = Bun.spawnSync([script, "--dry-run", ...args], { env: { ...process.env, FACTORY_HOME: "/tmp/fh" } });
  return { code: p.exitCode, out: p.stdout.toString() };
};

describe("lightning-2 demo script", () => {
  test("up builds the five windows the walkthrough names, in its order", () => {
    const { code, out } = dry("up");
    expect(code).toBe(0);
    const windows = [...out.matchAll(/new-(?:session|window) .*?-n (\w+)/g)].map((m) => m[1]);
    expect(windows).toEqual(["you", "factory", "logs", "boundary", "flow"]);
    const walkthrough = readFileSync(join(root, "teach/lightning-2.md"), "utf8");
    for (const w of windows) expect(walkthrough).toContain(`| \`${w}\` |`);
    expect(out).toContain("scene\\ 0:\\ setup");
    for (const line of out.split("\n").filter((l) => /^tmux (new-session|new-window|split-window)/.test(l)))
      expect(line).toContain("GH_PAGER=cat");
  });

  test("--tmux passes --tmux to the watcher through make up; without it the watcher is unchanged", () => {
    expect(dry("--tmux", "up").out).toContain("WATCH_ARGS=--tmux");
    expect(dry("up").out).not.toContain("WATCH_ARGS");
    const makefile = readFileSync(join(root, "Makefile"), "utf8");
    expect(makefile).toMatch(/factory watch --repo-dir "\$\$\{REPO_DIR:-\.\}" \$\(WATCH_ARGS\)/);
    expect(dry("scene", "5").out).toContain("watch\\ and\\ take\\ over");
  });

  test("up refuses, naming the holder, when the dashboard port is already taken", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
    try {
      const p = Bun.spawnSync([script, "up"], {
        env: {
          ...process.env,
          FACTORY_HOME: "/tmp/fh",
          DEMO_SESSION: `port-guard-${process.pid}`,
          FACTORY_DASHBOARD_PORT: String(server.port),
        },
      });
      expect(p.exitCode).toBe(1);
      expect(p.stderr.toString()).toContain(`port ${server.port} is held by pid ${process.pid}`);
    } finally {
      server.stop(true);
    }
  });

  test("snap writes html and png under the runner version's recording dir", () => {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    const { code, out } = dry("snap", "01-two-worktrees", "factory");
    expect(code).toBe(0);
    expect(out).toContain(`/tmp/fh/recordings/lightning-2/v${version}/01-two-worktrees.png`);
    expect(out).toContain("lightning-2:factory");
  });

  test("--record wraps the attach in asciinema; an unknown scene fails", () => {
    expect(dry("--record", "attach").out).toContain("asciinema rec --idle-time-limit 2");
    expect(dry("scene", "9").code).toBe(2);
  });

  test("snapshot and replay print the backup, the copy and the dashboard on the replay port", () => {
    const snap = dry("snapshot", "/tmp/snap").out;
    expect(snap).toContain(
      "sqlite3 /tmp/fh/learnwithparam/splitbill-demo/factory.db .backup\\ \\'/tmp/snap/learnwithparam/splitbill-demo/factory.db\\'",
    );
    const replay = dry("replay", "/tmp/snap").out;
    expect(replay).toContain("FACTORY_HOME=/tmp/snap bun");
    expect(replay).toContain("dashboard --repo learnwithparam/splitbill-demo --port 4101");
  });

  // The real thing: snapshot a FACTORY_HOME, wipe it as reset would, then serve and read the snapshot.
  test("a snapshot taken before reset serves the run's line, runs and artifacts after it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "factory-snap-"));
    const home = join(tmp, "home");
    const repoHome = join(home, "acme", "widgets");
    const runs = join(repoHome, "workspaces", "issue-7", ".factory", "runs", "issue-7");
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, "plan.md"), "plan for seven");
    const state = new FactoryState(join(repoHome, "factory.db"));
    state.upsertRun({ issue: 7, repo: "acme/widgets", title: "README run steps", stage: "verify", status: "shipped" });
    state.recordStageRun({
      repo: "acme/widgets",
      issue: 7,
      stage: "build",
      agent: "claude",
      model: null,
      started_at: "2026-10-01T00:00:00Z",
      finished_at: "2026-10-01T00:01:00Z",
      duration_ms: 60000,
      tool_calls: 3,
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: 0.25,
      exit_code: 0,
      killed_reason: null,
    });
    const env = { ...process.env, FACTORY_HOME: home, DEMO_REPO: "acme/widgets" };
    const out = join(tmp, "snapshot");
    let server: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const taken = Bun.spawnSync([script, "snapshot", out], { env });
      expect(taken.stderr.toString()).toBe("");
      expect(taken.exitCode).toBe(0);
      const again = Bun.spawnSync([script, "snapshot", out], { env });
      expect(again.exitCode).toBe(1);
      expect(again.stderr.toString()).toContain("already exists");
      state.close();
      rmSync(repoHome, { recursive: true, force: true });

      const free = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = free.port;
      free.stop(true);
      server = Bun.spawn([script, "replay", out], {
        env: { ...env, REPLAY_PORT: String(port) },
        stdout: "pipe",
        stderr: "pipe",
      });
      const base = `http://127.0.0.1:${port}`;
      let line: { rows: { run: { issue: number }; stages: { stage: string; ok: boolean }[] }[] } | undefined;
      for (let i = 0; i < 100 && !line; i++) {
        line = await fetch(`${base}/api/line`)
          .then((r) => r.json() as never)
          .catch(() => undefined);
        if (!line) await Bun.sleep(100);
      }
      expect(line?.rows.map((r) => r.run.issue)).toEqual([7]);
      expect(line?.rows[0]?.stages).toEqual([expect.objectContaining({ stage: "build", ok: true })]);
      expect(JSON.stringify(await (await fetch(`${base}/api/runs`)).json())).toContain("README run steps");
      expect(JSON.stringify(await (await fetch(`${base}/api/issues/7/artifacts`)).json())).toContain("plan.md");
      expect(await (await fetch(`${base}/api/issues/7/artifacts?file=plan.md`)).text()).toContain("plan for seven");
    } finally {
      server?.kill();
      await server?.exited;
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(existsSync(tmp)).toBe(false);
  });

  test("replay refuses a dir with no snapshot", () => {
    const p = Bun.spawnSync([script, "replay", "/nonexistent/snap"], {
      env: { ...process.env, FACTORY_HOME: "/tmp/fh" },
    });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("no snapshot at /nonexistent/snap");
  });

  test("snap.ts renders colour, bold and reset, and escapes html", () => {
    expect(ansiToHtml("\x1b[1;32mok\x1b[0m <b>")).toBe(
      '<span style="color:#23d18b;font-weight:bold">ok</span> &lt;b&gt;',
    );
    expect(ansiToHtml("\x1b[38;5;196mred")).toBe('<span style="color:rgb(255,0,0)">red</span>');
    const page = renderPage("s:w", [
      { left: 0, top: 0, width: 80, height: 10, text: "a" },
      { left: 0, top: 11, width: 80, height: 10, text: "b" },
    ]);
    expect(page.match(/<pre /g)?.length).toBe(2);
    expect(page).toContain("top:calc(11 * var(--lh))");
  });
});
