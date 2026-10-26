// Safe outputs: an agent stage reads and writes files in its worktree; only the runner's executor
// talks to the tracker or GitHub, with tokens the agent never sees. A repo's agentCommands are
// held to an allowlist of shapes, since a denylist of commands is bypassed by any wrapper.

// Executables that run another command or arbitrary code, so the rule says nothing about what runs.
const WRAPPERS = new Set([
  ...["env", "bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "exec", "sudo", "doas", "nohup", "timeout"],
  ...["xargs", "command", "builtin", "source", ".", "nice", "time", "watch", "parallel", "script"],
  ...["node", "bun", "bunx", "npx", "pnpx", "deno", "perl", "ruby", "php", "lua", "osascript"],
]);
const INTERPRETER = /^(python|pypy|node|ruby|perl|php)[\d.]*$/;
// Commands that reach GitHub, the tracker or the network themselves.
const OUTWARD = new Set(["gh", "hub", "glab", "curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "rsync", "ftp"]);
const OUTWARD_GIT = new Set(["push", "remote", "send-email", "credential", "config", "request-pull", "submodule"]);
const PUBLISH = new Set(["npm", "pnpm", "yarn", "cargo", "twine", "gem", "poetry"]);
// git options before the subcommand; the ones in GIT_VALUE take the next word as their value.
const GIT_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

// Why a repo's agentCommands pattern is refused, or undefined when it is allowed. A pattern is
// fixed words with at most one trailing wildcard (`make test`, `make *`, `make:*`).
export function refusal(pattern: string): string | undefined {
  const p = pattern.trim().toLowerCase();
  const body = p.replace(/(\s\*|:\*)$/, "");
  if (body.includes("*")) return "a wildcard is allowed only at the end, after fixed words";
  if (/[;&|`$()<>\\\n'"]/.test(body)) return "no shell syntax: one plain command";
  const words = body.split(/\s+/).filter(Boolean);
  const argv0 = words[0] ?? "";
  if (!argv0) return "empty";
  if (argv0.includes("/")) return "name the command, not a path to it";
  if (argv0.includes("=")) return "no VAR=value before the command";
  if (WRAPPERS.has(argv0) || INTERPRETER.test(argv0)) return `${argv0} runs other commands`;
  if (OUTWARD.has(argv0)) return `${argv0} reaches outside the worktree; the runner does that`;
  if (PUBLISH.has(argv0) && words.includes("publish")) return "publishing is the runner's job";
  if (argv0 === "git") {
    let i = 1;
    while (i < words.length && words[i]!.startsWith("-")) {
      const w = words[i]!;
      if (w === "-c" || w.startsWith("--config-env")) return "git -c can rewrite what any git command runs";
      i += GIT_VALUE.has(w) ? 2 : 1;
    }
    const sub = words[i];
    if (sub && OUTWARD_GIT.has(sub)) return `git ${sub} reaches outside the worktree; the runner does that`;
    if (p !== body && sub === undefined) return "git with a wildcard subcommand";
  }
  return undefined;
}

export function safeCommands(patterns: readonly string[] | undefined): string[] {
  return (patterns ?? []).filter((p) => refusal(p) === undefined);
}

// The built-in rules are fixed in stage-permissions.ts; this pins that none of them reaches out.
export function isOutward(rule: string): boolean {
  const cmd = /^Bash\((.*)\)$/.exec(rule)?.[1]?.trim();
  if (cmd === undefined) return false;
  const [argv0 = "", sub] = cmd.toLowerCase().split(/\s+/);
  return OUTWARD.has(argv0) || (argv0 === "git" && OUTWARD_GIT.has(sub ?? ""));
}
