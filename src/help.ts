// The CLI's help text. tests/help.test.ts diffs COMMANDS against the
// dispatcher in bin/factory so a new command can't ship undocumented.

export const COMMANDS: { name: string; usage: string; does: string }[] = [
  {
    name: "up",
    usage: "up [--repo-dir <path> | --repo <owner/name>] [--tmux]",
    does: "no repo: control plane + relay (the image default); with a repo: watch + dashboard in one process; --tmux: each in a tmux window, plus one per issue",
  },
  {
    name: "watch",
    usage: "watch (--repo-dir <path> | --repo <owner/name>) [--once]",
    does: "poll and drive the loop; --once = one pass",
  },
  {
    name: "run",
    usage: "run (--repo-dir <path> | --repo <owner/name>) (--issue <N> | --pr <N>)",
    does: "advance one issue (or the issue a PR works on) once, then exit (CI)",
  },
  {
    name: "tick",
    usage: "tick (--repo-dir <path> | --repo <owner/name>)",
    does: "one poll pass over every open issue, then exit (cron)",
  },
  {
    name: "park",
    usage: "park --repo-dir <path> (--issue <N> | --pr <N>) [--reason <text>]",
    does: "park an issue as needs-human from outside the loop",
  },
  {
    name: "daemon",
    usage: "daemon (install | uninstall) (--repo-dir <path> | --repo <owner/name>)",
    does: "run `up` in the background at login, restarted when it exits (launchd on macOS, systemd user unit on Linux)",
  },
  {
    name: "dashboard",
    usage: "dashboard [--repo <owner/name> | --repo-dir <path>] [--port <n>]",
    does: "serve the board (default :4100, loopback)",
  },
  {
    name: "attach",
    usage: "attach [<N>] (--repo <owner/name> | --repo-dir <path>) [--session <name>]",
    does: "join the tmux session; with <N>, open that issue's live window (works over ssh -t and docker exec -it)",
  },
  {
    name: "takeover",
    usage: "takeover <N> (--repo-dir <path> | --repo <owner/name>) [--no-handback]",
    does: "stop #N's running stage, open its Claude session in the worktree, and /factory retry when you exit",
  },
  {
    name: "logs",
    usage: "logs <N> [--repo <owner/name>] [--stage <name>] [--follow] [--json]",
    does: "print (or follow) a run's events; --json is one object per line",
  },
  {
    name: "view",
    usage: "view <stream-file> [--follow]",
    does: "render a stage's raw agent output in colour: tool calls, edit diffs, test results (the tmux issue window runs this)",
  },
  {
    name: "mcp",
    usage: "mcp (--repo <owner/name> | --repo-dir <path>) [--as <name>]",
    does: "serve MCP on stdio, so an agent or IDE can list, read, start and approve tasks",
  },
  {
    name: "runner",
    usage: "runner register --url <plane> [--name <n>] (token on stdin) | runner start --repo-dir <path>",
    does: "register this machine with a control plane once, then dial out for work with heartbeats",
  },
  {
    name: "pair",
    usage: "pair --url <plane> --login <member> (FACTORY_DASHBOARD_TOKEN set)",
    does: "print a QR that pairs a phone to the plane as that member",
  },
  {
    name: "inbox",
    usage: "inbox [<N> <action> [--text <words>]] (--repo <owner/name> | --repo-dir <path>) [--json]",
    does: "list what waits for a human; with <N> <action>, post the same /factory comment a human would",
  },
  {
    name: "scan",
    usage: "scan --repo-dir <path> [--lighthouse <report.json>]",
    does: "file issues from `osv-scanner` (any lockfile), else `bun audit` on a Bun project; with --lighthouse, one per page below its bar",
  },
  {
    name: "reset",
    usage: "reset --repo-dir <path> [--dry-run] [--all-issues]",
    does: "DESTRUCTIVE: force base back to the baseline tag (lists dropped commits), close PRs and factory issues (--all-issues: every open issue)",
  },
  {
    name: "rebaseline",
    usage: "rebaseline --repo-dir <path> [--dry-run]",
    does: "move the baseline tag to origin/<base>, keeping merged setup changes across reset",
  },
  {
    name: "doctor",
    usage: "doctor --repo-dir <path> [--fix]",
    does: "check the loop can run; --fix creates missing labels",
  },
  {
    name: "verify-agent",
    usage: "verify-agent <name> --repo-dir <path> --issue <N> [--out <dir>]",
    does: "run one issue on that agent, record a scrubbed fixture, print pass/fail, cost and tokens",
  },
  {
    name: "learn",
    usage: "learn (--repo-dir <path> | --repo <owner/name>) [--export <file|-> [--since <date>]]",
    does: "batch pending retro lessons and skill-edit proposals into one factory/learning-<date> PR; --export writes runs, stages and retros as v1 JSONL instead",
  },
  {
    name: "init",
    usage: "init [--repo-dir <path>] [--dry-run] [--force] [--pr]",
    does: "detect the repo's stack and write .factory/config.json gates, setup and commands; installs the template first if missing",
  },
  {
    name: "harness",
    usage: "harness (validate | inventory | scaffold <name> | eval [--since <days>]) --repo-dir <path> [--json]",
    does: "validate: every workflow file and every one the config names loads (exit 4 if not); inventory: each workflow's steps, cron triggers and routed types; scaffold: write a starting .factory/workflows/<name>.md; eval: runs, shipped rate, failed steps and cost per workflow from the event log",
  },
  {
    name: "teach",
    usage: 'teach "<how we ship>" (--repo-dir <path> | --repo <owner/name>) [--json]',
    does: "one agent reads the repo, its CI and the brain MCP server, and opens a PR with the workflows, minions and skills it proposes, each checked first",
  },
  {
    name: "minion",
    usage: "minion (list | run <name> [--event <json-file>]) --repo-dir <path> [--json]",
    does: "list: every .factory/minions file, checked (exit 4 on a problem); run: one minion now, with an optional CloudEvent as its trigger",
  },
  {
    name: "events",
    usage: "events (tail [--limit N] | replay <id>) --repo-dir <path> [--json]",
    does: "tail: recent events in and out, with each sink's delivery status; replay: send one event to its sinks again",
  },
  {
    name: "pool",
    usage: "pool [--json]",
    does: "each pool runtime in machine.json: every member's free minutes used and left this month, and its last failure",
  },
  {
    name: "runtime",
    usage: "runtime (list [--probe] | verify <name>) [--json]",
    does: "list runtimes with their sandbox flags (--probe: does each answer); verify runs the shared conformance kit on one",
  },
  {
    name: "dispatch",
    usage: "dispatch (--repo-dir <path> | --repo <owner/name>) [--json]",
    does: "the issues one tick would advance, written to $GITHUB_OUTPUT as a matrix for one `factory run` job each",
  },
  {
    name: "routine",
    usage: "routine (--repo <owner/name> | --repo-dir <path>) [--cron <expr>] [--json]",
    does: "print a Claude Code cloud routine (name, cron, prompt) that runs `factory tick` on a schedule",
  },
  {
    name: "receipt",
    usage: "receipt (keygen --out <key.pem> | verify <receipt.dsse.json> --pubkey <key.pub>) [--json]",
    does: "keygen: an Ed25519 key that signs each run's acceptance receipt; verify: check one here (kaas-verify checks it with no factory code)",
  },
  {
    name: "install",
    usage: "install <target-dir> [--dry-run] [--update] [--ci] [--agents a,b,c]",
    does: "install or update the template in a repo; --agents links skills into each agent dir",
  },
];

export const OPTIONS: [string, string][] = [
  ["--db <path>", "SQLite telemetry cache (default ~/.factory/state.db)"],
  ["--workspaces <dir>", "worktree root (default ~/.factory/workspaces)"],
  [
    "--json",
    "run, tick, watch --once, doctor and harness: print {ok,data} on stdout, and errors as {ok:false,error} on stderr",
  ],
  ["--tmux", "watch and up: show each issue's live transcript in a tmux window (config tmux.enabled does the same)"],
  ["-h, --help", "print this help; after a command, that command's usage"],
  ["--port <n>", "dashboard port (default FACTORY_DASHBOARD_PORT or 4100)"],
];

export const ENV: [string, string][] = [
  ["FACTORY_HOME", "state root (clones, worktrees, db)"],
  ["FACTORY_MODE", "set to `actions` when GitHub Actions drives the repo; doctor checks the workflow exists"],
  ["FACTORY_DASHBOARD_HOST / _PORT / _TOKEN", "dashboard bind; a non-loopback host requires the token"],
  ["FACTORY_DB_PATH / FACTORY_REPO", "dashboard-only defaults for --db / --repo"],
  [
    "FACTORY_EVENTS_SECRET",
    "HMAC secret POST /events checks (config events.inboundSecretEnv names another); unset turns the route off",
  ],
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
