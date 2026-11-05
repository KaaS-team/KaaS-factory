// The `qa` step kind: renders what a running app showed as a PR body section. The render is pure;
// the runner that starts the app is injected, so tests never start one. Off unless FACTORY_QA=1.
import { finish, moveLabel, postComment } from "./engine/common";
import type { StepCtx, StepResult, StepType } from "./engine/steps";
import { runDir } from "./artifacts";
import { LABEL } from "./labels";
import { readQa } from "./qa";
import { ShellSetupRunner } from "./setup";
import { runGit, type RunGit } from "./assets-branch";
import { compareShotDirs, writeVisualReport } from "./visual-compare";
import { publishVisualReport, reportLinks } from "./visual-publish";
import { join } from "node:path";

export interface QaCriterion {
  readonly id: string;
  readonly text: string;
  // The plan routes this criterion is exercised on.
  readonly routes: readonly string[];
}
export interface QaRouteResult {
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
}
export interface QaInput {
  readonly routes: readonly string[];
  readonly run: string;
  readonly results: readonly QaRouteResult[];
  readonly criteria?: readonly QaCriterion[];
}

// pass: every route of the criterion was visited and ok. fail: one failed or was not visited.
// not exercised: the criterion names no route.
export function criterionVerdict(c: QaCriterion, results: readonly QaRouteResult[]): "pass" | "fail" | "not exercised" {
  if (c.routes.length === 0) return "not exercised";
  return c.routes.every((p) => results.some((r) => r.path === p && r.ok)) ? "pass" : "fail";
}

export function renderQa(input: QaInput): string {
  const visited = new Map(input.results.map((r) => [r.path, r]));
  const rows = input.routes.map((p) => {
    const r = visited.get(p);
    return r ? `| \`${p}\` | ${r.status} | ${r.ok ? "pass" : "fail"} |` : `| \`${p}\` | none | fail |`;
  });
  const out = [
    "## QA",
    "",
    `App started with \`${input.run}\`.`,
    "",
    "| Route | Status | Result |",
    "| --- | --- | --- |",
    ...rows,
  ];
  if (input.criteria?.length) {
    out.push("", "| Acceptance criterion | Result |", "| --- | --- |");
    for (const c of input.criteria) out.push(`| ${c.id}: ${c.text} | ${criterionVerdict(c, input.results)} |`);
  }
  return out.join("\n");
}

// Starting the app. The spawner, the probe and the clock are injected so tests start no process.
export interface AppHandle {
  readonly exited: Promise<number>;
  output(): string;
  stop(): Promise<void>;
}
export interface AppSpec {
  readonly command: string;
  readonly url: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}
export interface AppPorts {
  readonly spawn: (command: string, cwd: string) => AppHandle;
  readonly probe: (url: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}
export class AppStartError extends Error {}

// Starts the app, waits until the url answers, runs `use`, and stops the app whether `use` passed or not.
// An app that exits before it answers, or never answers within the timeout, throws with its output.
export async function withRunningApp<T>(spec: AppSpec, ports: AppPorts, use: () => Promise<T>): Promise<T> {
  const app = ports.spawn(spec.command, spec.cwd);
  try {
    const deadline = ports.now() + (spec.timeoutMs ?? 30_000);
    let exit: number | undefined;
    void app.exited.then((c) => {
      exit = c;
    });
    for (;;) {
      if (await ports.probe(spec.url)) break;
      if (exit !== undefined) {
        throw new AppStartError(
          `\`${spec.command}\` exited ${exit} before it answered at ${spec.url}\n${app.output()}`,
        );
      }
      if (ports.now() >= deadline) {
        throw new AppStartError(`\`${spec.command}\` did not answer at ${spec.url} in time\n${app.output()}`);
      }
      await ports.sleep(spec.intervalMs ?? 250);
    }
    return await use();
  } finally {
    await app.stop();
  }
}

// The real ports: a bash child in its own process group so stop() ends the app's children too.
export const realAppPorts: AppPorts = {
  spawn(command, cwd) {
    const p = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", detached: true });
    let out = "";
    for (const stream of [p.stdout, p.stderr]) {
      void (async () => {
        for await (const chunk of stream) out += Buffer.from(chunk).toString();
      })().catch(() => {});
    }
    return {
      exited: p.exited,
      output: () => out.slice(-4000),
      async stop() {
        try {
          process.kill(-p.pid, "SIGTERM");
        } catch {
          // already gone
        }
        await Promise.race([p.exited, new Promise((r) => setTimeout(r, 2000))]);
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          // already gone
        }
      },
    };
  },
  async probe(url) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export type QaRunner = (run: string, routes: readonly string[]) => Promise<readonly QaRouteResult[]>;

export const qaEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.FACTORY_QA === "1";

// Not enabled: the step is skipped and the workflow goes on. Enabled: the runner drives the app.
// No routes named: the routes the runner visited are the ones judged, and none visited is not ok.
export async function runQaStep(
  input: Omit<QaInput, "results">,
  runner: QaRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ readonly ran: boolean; readonly section?: string; readonly ok: boolean }> {
  if (!qaEnabled(env)) return { ran: false, ok: true };
  const results = await runner(input.run, input.routes);
  const routes = input.routes.length ? input.routes : results.map((r) => r.path);
  return {
    ran: true,
    section: renderQa({ ...input, routes, results }),
    ok: routes.length > 0 && routes.every((p) => results.some((r) => r.path === p && r.ok)),
  };
}

// The registered kind. The step's `run:` command starts the app and writes qa.json (template
// .factory/qa.sh); the routes in it are judged by runQaStep and the table is posted as a stage comment.
// Not enabled: skipped. A runner that throws or a failed route parks the issue failed, never a crash.
// FACTORY_QA_APP (the repo's run command) and FACTORY_QA_URL name the app. When both are set the step
// starts the app itself and the step's `run:` command (qa.sh) is told not to start a second one.
export const qaStep: StepType = {
  command: true,
  async run(sc: StepCtx): Promise<StepResult> {
    if (!qaEnabled()) return { kind: "next", facts: { ok: true, skipped: true } };
    const { deps, config, issue, worktree, step } = sc;
    const name = step.runtime ?? config.runtime?.check;
    const runtime = name ? deps.runtimes?.[name] : (deps.setupRunner ?? new ShellSetupRunner());
    let outcome: Awaited<ReturnType<typeof runQaStep>>;
    let error: string | undefined;
    try {
      if (!runtime) throw new Error(`no runtime "${name}" on this machine`);
      const appCmd = process.env.FACTORY_QA_APP;
      const appUrl = process.env.FACTORY_QA_URL;
      const drive = async (run: string) => {
        const out = await runtime.run(run, worktree);
        if (out.code !== 0) throw new Error(`\`${run}\` exited ${out.code}`);
        return readQa(worktree, issue.number)?.routes ?? [];
      };
      outcome = await runQaStep({ routes: [], run: step.run! }, (run) =>
        appCmd && appUrl
          ? withRunningApp(
              { command: appCmd, url: appUrl, cwd: worktree },
              (deps as { appPorts?: AppPorts }).appPorts ?? realAppPorts,
              () => drive(`QA_COMMAND=: QA_URL=${JSON.stringify(appUrl)} ${run}`),
            )
          : drive(run),
      );
    } catch (e) {
      outcome = { ran: true, ok: false };
      error = e instanceof Error ? e.message : String(e);
    }
    // The tolerant screenshot report rides in the same comment; it informs, the route verdict decides.
    const visual = compareShotDirs(
      join(worktree, ".factory/visual/baseline"),
      join(worktree, runDir(issue.number), "visual"),
    );
    const reportDir = join(worktree, runDir(issue.number), "visual-report");
    writeVisualReport(
      join(worktree, ".factory/visual/baseline"),
      join(worktree, runDir(issue.number), "visual"),
      reportDir,
    );
    // A failing shot gets its diff image and the HTML report pushed and linked. A push that fails
    // leaves the comment without links; the route verdict is unaffected.
    let links = "";
    if (visual && !visual.ok) {
      try {
        const git = (deps as { assetsGit?: RunGit }).assetsGit ?? runGit;
        const pub = await publishVisualReport(git, worktree, {
          repo: config.repo,
          issue: issue.number,
          dir: reportDir,
        });
        if (pub) links = reportLinks(pub);
      } catch {
        // not published
      }
    }
    const visualSection = visual ? [visual.section, links].filter(Boolean).join("\n\n") : "";
    if (outcome.ok) {
      const body = visual ? `${outcome.section ?? ""}\n\n${visualSection}` : (outcome.section ?? "");
      await postComment(deps, config, issue.number, body, { stage: step.id, json: { ok: true } });
      return { kind: "next", facts: { ok: true } };
    }
    const body = outcome.section ?? `Step \`${step.id}\` failed: ${error ?? "no route was visited"}.`;
    await postComment(deps, config, issue.number, body, { stage: step.id, json: { ok: false } });
    await moveLabel(deps, config, issue.number, step.label, LABEL.failed);
    finish(deps, config, issue.number, "failed", `${step.id}: ${error ?? "a route failed"}`);
    return { kind: "stop", outcome: "failed" };
  },
};
