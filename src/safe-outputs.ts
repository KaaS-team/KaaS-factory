// Safe outputs: an agent stage reads and writes files in its worktree; only the runner's executor
// talks to the tracker or GitHub, with tokens the agent never sees. A repo's agentCommands are
// held to an allowlist of shapes, since a denylist of commands is bypassed by any wrapper.

import type { OutputKind, Outputs } from "./core/workflow-outputs";
import type { CreatePrOptions, ScmPort } from "./ports/scm";

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

// ---- Declared outputs (#637): what a workflow's run may write, how much, and for how long. ----

// The write the workflow did not declare, or one past its maximum.
export class WriteRefused extends Error {}

export type Tally = Map<OutputKind, number>;
const MARK = "<!-- factory:expires ";

// The title with the declared prefix, and the count taken: or the reason it is refused. With no
// `outputs:` the workflow declared nothing, so nothing is gated (every shipped workflow today).
export function admit(
  outputs: Outputs | undefined,
  tally: Tally,
  kind: OutputKind,
  title?: string,
): string | undefined {
  if (!outputs) return title;
  const decl = outputs[kind];
  if (!decl) throw new WriteRefused(`the workflow declares no ${kind} output`);
  const used = tally.get(kind) ?? 0;
  if (used >= decl.max) throw new WriteRefused(`${kind}: past the maximum of ${decl.max} per run`);
  tally.set(kind, used + 1);
  const prefix = decl.titlePrefix;
  return title !== undefined && prefix && !title.startsWith(prefix) ? `${prefix}${title}` : title;
}

export const expiryLine = (days: number, now: Date): string =>
  `${MARK}${new Date(now.getTime() + days * 86_400_000).toISOString()} -->`;

// The ScmPort a run's steps get when the workflow declares outputs: an issue, a PR, a label of
// its own or a comment on another item is counted, prefixed and refused here. The run's own
// thread (factory labels, status comments) is the runner's, not an output.
export function gateScm<T extends ScmPort>(
  github: T,
  outputs: Outputs,
  tally: Tally,
  runIssue: number,
  now: () => Date,
): T {
  const days = outputs.issue?.expiresDays;
  return Object.create(github, {
    createIssue: {
      value: async (repo: string, title: string, body: string, labels: string[]) =>
        github.createIssue(
          repo,
          admit(outputs, tally, "issue", title)!,
          days ? `${body}\n\n${expiryLine(days, now())}` : body,
          labels,
        ),
    },
    createPr: {
      value: async (opts: CreatePrOptions) =>
        github.createPr({ ...opts, title: admit(outputs, tally, "pull_request", opts.title)! }),
    },
    addLabels: {
      value: async (repo: string, n: number, labels: string[]) => {
        for (const l of labels) if (!l.startsWith("factory:")) admit(outputs, tally, "label");
        return github.addLabels(repo, n, labels);
      },
    },
    commentIssue: {
      value: async (repo: string, n: number, body: string) => {
        if (n !== runIssue) admit(outputs, tally, "comment");
        return github.commentIssue(repo, n, body);
      },
    },
  }) as T;
}

const DIFF_CAP = 50_000;

// The issue a protected-path PR becomes: the paths named and the diff attached.
export function protectedFallbackBody(prTitle: string, hits: readonly string[], diff: string): string {
  const shown = diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n... (diff truncated)` : diff;
  const fence = "`".repeat(Math.max(3, ...(shown.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return [
    `A pull request ("${prTitle}") was not opened because it touches protected paths:`,
    ...hits.map((h) => `- \`${h}\``),
    "",
    `A maintainer applies the change by hand.\n\n${fence}diff\n${shown}\n${fence}`,
  ].join("\n");
}

// Closes each open issue that carries a past expiry and has had no human comment, with one comment saying why.
export async function closeExpired(
  github: Pick<ScmPort, "listOpenIssues" | "commentIssue" | "closeIssue">,
  repo: string,
  now: Date,
): Promise<number[]> {
  const closed: number[] = [];
  for (const issue of await github.listOpenIssues(repo)) {
    const at = Date.parse(new RegExp(`${MARK}(\\S+) -->`).exec(issue.body ?? "")?.[1] ?? "");
    if (Number.isNaN(at) || at > now.getTime()) continue;
    if (issue.comments.some((c) => !c.body.includes("<!-- factory:"))) continue;
    await github.commentIssue(
      repo,
      issue.number,
      `Closing: this item expired on ${new Date(at).toISOString().slice(0, 10)} and nobody had commented on it.\n\n<!-- factory:expired -->`,
    );
    await github.closeIssue(repo, issue.number);
    closed.push(issue.number);
  }
  return closed;
}
