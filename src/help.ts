// The CLI's help text. tests/help.test.ts diffs COMMANDS against the
// dispatcher in bin/factory so a new command can't ship undocumented.

export const COMMANDS: { name: string; usage: string; does: string }[] = [
  { name: "up", usage: "up (--repo-dir <path> | --repo <owner/name>) [--tmux]", does: "watch + dashboard in one process (Docker/VM); --tmux: each in a tmux window, plus one per issue" },
  { name: "watch", usage: "watch (--repo-dir <path> | --repo <owner/name>) [--once]", does: "poll and drive the loop; --once = one pass" },
  { name: "run", usage: "run (--repo-dir <path> | --repo <owner/name>) (--issue <N> | --pr <N>)", does: "advance one issue (or the issue a PR works on) once, then exit (CI)" },
  { name: "tick", usage: "tick (--repo-dir <path> | --repo <owner/name>)", does: "one poll pass over every open issue, then exit (cron)" },
  { name: "park", usage: "park --repo-dir <path> (--issue <N> | --pr <N>) [--reason <text>]", does: "park an issue as needs-human from outside the loop" },
  { name: "daemon", usage: "daemon (install | uninstall) (--repo-dir <path> | --repo <owner/name>)", does: "run `up` in the background at login, restarted when it exits (launchd on macOS, systemd user unit on Linux)" },
  { name: "dashboard", usage: "dashboard [--repo <owner/name> | --repo-dir <path>] [--port <n>]", does: "serve the board (default :4100, loopback)" },
  { name: "attach", usage: "attach [<N>] (--repo <owner/name> | --repo-dir <path>) [--session <name>]", does: "join the tmux session; with <N>, open that issue's live window (works over ssh -t and docker exec -it)" },
  { name: "takeover", usage: "takeover <N> (--repo-dir <path> | --repo <owner/name>) [--no-handback]", does: "stop #N's running stage, open its Claude session in the worktree, and /factory retry when you exit" },
  { name: "logs", usage: "logs <N> [--repo <owner/name>] [--stage <name>] [--follow] [--json]", does: "print (or follow) a run's events; --json is one object per line" },
  { name: "inbox", usage: "inbox [<N> <action> [--text <words>]] (--repo <owner/name> | --repo-dir <path>) [--json]", does: "list what waits for a human; with <N> <action>, post the same /factory comment a human would" },
  { name: "scan", usage: "scan --repo-dir <path>", does: "file issues from `osv-scanner` (any lockfile), else `bun audit` on a Bun project" },
  { name: "reset", usage: "reset --repo-dir <path> [--dry-run] [--all-issues]", does: "DESTRUCTIVE: force base back to the baseline tag (lists dropped commits), close PRs and factory issues (--all-issues: every open issue)" },
  { name: "rebaseline", usage: "rebaseline --repo-dir <path> [--dry-run]", does: "move the baseline tag to origin/<base>, keeping merged setup changes across reset" },
  { name: "doctor", usage: "doctor --repo-dir <path> [--fix]", does: "check the loop can run; --fix creates missing labels" },
  { name: "verify-agent", usage: "verify-agent <name> --repo-dir <path> --issue <N> [--out <dir>]", does: "run one issue on that agent, record a scrubbed fixture, print pass/fail, cost and tokens" },
  { name: "learn", usage: "learn (--repo-dir <path> | --repo <owner/name>)", does: "batch pending retro lessons and skill-edit proposals into one factory/learning-<date> PR" },
  { name: "init", usage: "init [--repo-dir <path>] [--dry-run] [--force] [--pr]", does: "detect the repo's stack and write .factory/config.json gates, setup and commands; installs the template first if missing" },
  { name: "harness", usage: "harness (validate | inventory) --repo-dir <path> [--json]", does: "validate: every workflow file and every one the config names loads (exit 4 if not); inventory: each workflow's steps, cron triggers and routed types" },
  { name: "install", usage: "install <target-dir> [--dry-run] [--update] [--ci] [--agents a,b,c]", does: "install or update the template in a repo; --agents links skills into each agent dir" },
];

export const OPTIONS: [string, string][] = [
  ["--db <path>", "SQLite telemetry cache (default ~/.factory/state.db)"],
  ["--workspaces <dir>", "worktree root (default ~/.factory/workspaces)"],
  ["--json", "run, tick, watch --once, doctor and harness: print {ok,data} on stdout, and errors as {ok:false,error} on stderr"],
  ["--tmux", "watch and up: show each issue's live transcript in a tmux window (config tmux.enabled does the same)"],
  ["--port <n>", "dashboard port (default FACTORY_DASHBOARD_PORT or 4100)"],
];

export const ENV: [string, string][] = [
  ["FACTORY_HOME", "state root (clones, worktrees, db)"],
  ["FACTORY_MODE", "set to `actions` when GitHub Actions drives the repo; doctor checks the workflow exists"],
  ["FACTORY_DASHBOARD_HOST / _PORT / _TOKEN", "dashboard bind; a non-loopback host requires the token"],
  ["FACTORY_DB_PATH / FACTORY_REPO", "dashboard-only defaults for --db / --repo"],
  ["GH_TOKEN, ANTHROPIC_API_KEY", "credentials for VM/CI modes; the runner strips them from the agent env"],
];

export function helpText(): string {
  const w = Math.max(...COMMANDS.map((c) => c.usage.length));
  return [
    "factory <command> [options]",
    "",
    ...COMMANDS.map((c) => `  ${c.usage.padEnd(w)}  ${c.does}`),
    "",
    "options:",
    ...OPTIONS.map(([k, v]) => `  ${k.padEnd(w)}  ${v}`),
    "",
    "environment:",
    ...ENV.map(([k, v]) => `  ${k}: ${v}`),
    "",
    "Humans answer through GitHub: /factory approve|revise <text>|retry|cancel in a trusted issue or PR comment.",
  ].join("\n");
}
