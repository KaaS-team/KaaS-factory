// The tmux view: one session, one window per issue in flight, each following that
// issue's stream. tmux only ever watches; the executor owns the agent, so a
// tmux failure is logged by the caller and never fails a stage.

import { streamPath } from "./paths";

export interface TmuxResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TmuxRunner {
  run(args: readonly string[]): Promise<TmuxResult>;
}

const TMUX_TIMEOUT_MS = 5000;

// `socket` is a `tmux -L` name; tests use their own so they never touch yours.
export class ShellTmuxRunner implements TmuxRunner {
  constructor(
    private readonly socket?: string,
    private readonly timeoutMs = TMUX_TIMEOUT_MS,
  ) {}

  async run(args: readonly string[]): Promise<TmuxResult> {
    const proc = Bun.spawn(["tmux", ...(this.socket ? ["-L", this.socket] : []), ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), this.timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// "owner/splitbill-demo" and 12 -> "splitbill-demo-12": two repos can share a session.
export function issueWindow(repo: string, issue: number): string {
  return `${repo.split("/").pop()}-${issue}`;
}

export class Tmux {
  constructor(
    private readonly runner: TmuxRunner,
    readonly session: string,
  ) {}

  private async must(args: readonly string[]): Promise<TmuxResult> {
    const result = await this.runner.run(args);
    if (result.code !== 0) throw new Error(`tmux ${args.join(" ")}: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result;
  }

  async version(): Promise<string> {
    return (await this.must(["-V"])).stdout.trim();
  }

  async hasSession(): Promise<boolean> {
    return (await this.runner.run(["has-session", "-t", `=${this.session}`])).code === 0;
  }

  async ensureSession(): Promise<void> {
    if (!(await this.hasSession())) await this.must(["new-session", "-d", "-s", this.session, "-x", "200", "-y", "50"]);
  }

  async windows(): Promise<string[]> {
    const result = await this.runner.run(["list-windows", "-t", `=${this.session}`, "-F", "#{window_name}"]);
    return result.code === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  }

  // Idempotent: an existing window of that name is left as it is.
  async ensureWindow(name: string, command: string, cwd?: string): Promise<void> {
    await this.ensureSession();
    if ((await this.windows()).includes(name)) return;
    await this.must(["new-window", "-d", "-t", `=${this.session}:`, "-n", name, ...(cwd ? ["-c", cwd] : []), command]);
  }

  async killWindow(name: string): Promise<void> {
    if ((await this.windows()).includes(name)) await this.must(["kill-window", "-t", `=${this.session}:=${name}`]);
  }
}

// What watch.ts sees: show an issue's transcript, and close it when the run ends.
export interface IssueView {
  show(issue: number, transcriptFile: string): Promise<void>;
  close(issue: number): Promise<void>;
}

// `factory` is the command line that runs this CLI; the window renders the stage's raw stream in colour.
export function tmuxIssueView(tmux: Tmux, repo: string, factory: string): IssueView {
  return {
    show: (issue, file) =>
      tmux.ensureWindow(issueWindow(repo, issue), `${factory} view ${shellQuote(streamPath(file))} --follow`),
    close: (issue) => tmux.killWindow(issueWindow(repo, issue)),
  };
}
