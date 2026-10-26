// The `factory` CLI. Commands are listed in src/help.ts (a test keeps the two in sync).
// bin/factory imports this file. Thin dispatcher; the logic lives in the other src/ modules so it
// stays testable without a child process.

import { accessSync, constants, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ScmPort } from "./github";
import { makeScm } from "./scm";
import { GitCommandRunner, Git, issueOfPr } from "./git";
import { FactoryState, DEFAULT_DB_PATH } from "./state";
import { tokenEnvNames } from "./agents/env";
import { CommandExecutor } from "./agents/executor";
import { DEFAULT_CONFIG, loadConfig, repoFromRemoteUrl, type FactoryConfig } from "./config";
import { EXIT, UsageError, failureJson, successJson } from "./cli-output";
import { advanceIssue, pollOnce, recoverInFlight, startWatch, type WatchDeps } from "./watch";
import { ShellGateRunner } from "./gates";
import { ShellHoldoutRunner } from "./holdout";
import { ShellSetupRunner } from "./setup";
import { DiffAnchorRechecker } from "./recheck";
import { scan, scanLighthouse } from "./scan";
import { streamLogs } from "./logs";
import { plain } from "./display";
import { act, buildInbox, inboxPositionals, parkReasons, type InboxAction } from "./inbox";
import { prItems } from "./stale-pr";
import { remoteCommand } from "./remote-cli";
import { reset, rebaseline } from "./reset";
import { runDoctor, fixDoctor } from "./doctor";
import { agentVm, loadMachineConfig, machineGateway, MachineLeases, MachineSpend } from "./machine";
import { createDashboard, servingAccess as plane } from "../dashboard/server";
import { startRelay } from "../dashboard/relay";
import { blobStoreFromEnv } from "./blobs";
import type { DashboardProject } from "../dashboard/project";
import { versionOf, which } from "./probes";
import {
  workspacesDir as defaultWorkspacesDir,
  defaultStatePath,
  factoryHome,
  livePath,
  transcriptPath,
} from "./paths";
import { issueWindow, shellQuote, ShellTmuxRunner, Tmux, tmuxIssueView } from "./tmux";
import { followStream } from "./view";
import { readLive, resumeArgv, stopRunningStage, takeoverBanner } from "./takeover";
import { LABEL } from "./labels";
import { ensureRepoClone } from "./repo";
import { daemonPlatform, installDaemon, uninstallDaemon } from "./daemon";
import { helpText } from "./help";
import { decodeStatement, type Envelope, generateReceiptKey, keyId, RECEIPT_KEY_ENV, verifyEnvelope } from "./receipt";
import { FixtureRecorder } from "./agents/record";
import { configFor, defaultFixtureDir, formatReport, reportFor } from "./verify-agent";
import { ShellProofGit } from "./proof";
import { runLearn } from "./learn";
import { routeWorkflowsFor, workflowFor } from "./engine/workflows";
import { formatInventory, harnessReport } from "./harness";
import { GitLeases } from "./adapters/git-lease/lease";
import { GitHubSpend } from "./adapters/github-store/spend";
import { spendPolicy } from "./ports/spend";
import { runtimeRefs, runtimesFrom, unknownRuntimes } from "./runtimes";
import { probeRuntime } from "./runtime-kit";
import { cmdDispatch, cmdPool, cmdRoutine, cmdRuntime } from "./cli-runtime";
import { detectStack, diskFiles } from "./stack";
import { describeStack, initConfig, isFilledIn, writeCharter } from "./init";
import { EventBus } from "./engine/bus";
import { loadMinions, runMinion } from "./engine/minion";
import { parseEvent } from "./core/event";
import { watcherBus } from "./integrations/wire";
const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const cli = { args, flag, has, resolveCloneDir: () => resolveCloneDir(), watchDeps: buildWatchDeps };

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

// `--repo-dir <path>` (local mode: the clone already exists) or `--repo
// owner/name` (VM/CI modes: nothing is on disk yet, clone it under
// FACTORY_HOME/repos and fetch+fast-forward on every later call). Exactly
// one of the two is required; `--repo-dir` wins if both are given.
async function resolveCloneDir(): Promise<string> {
  const repoDir = flag("repo-dir");
  if (repoDir) return resolve(repoDir);
  const repoSlug = flag("repo");
  if (repoSlug) {
    const dir = await ensureRepoClone(new GitCommandRunner(), repoSlug);
    console.error(`factory: --repo ${repoSlug} resolved to ${dir}`);
    return dir;
  }
  throw new UsageError("--repo-dir <path-to-clone> or --repo <owner/name> is required");
}

// tmux is on for this process when the config says so or `--tmux` was passed.
function tmuxFor(config: FactoryConfig): Tmux | undefined {
  return config.tmux.enabled || has("tmux") ? new Tmux(new ShellTmuxRunner(), config.tmux.session) : undefined;
}

// A view that would silently do nothing is a config error: refuse to start.
async function requireTmux(config: FactoryConfig): Promise<void> {
  const tmux = tmuxFor(config);
  if (!tmux) return;
  try {
    await tmux.version();
  } catch (err) {
    throw new Error(
      `tmux is enabled (config tmux.enabled or --tmux) but \`tmux -V\` failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function stateDbPath(repo: string): string {
  return flag("db") ?? process.env.FACTORY_DB_PATH ?? defaultStatePath(process.env, repo);
}

// Shared by watch/run/tick so all three modes (long-lived poll, one-shot CI
// step, cron tick) resolve the exact same paths and construct the exact same
// gate runner — one place, not three copies to drift (audit finding #1).
async function buildWatchDeps(cloneDir: string, config: FactoryConfig): Promise<WatchDeps> {
  const tmux = tmuxFor(config);
  const workflow = await workflowFor(cloneDir, config);
  const routeWorkflows = await routeWorkflowsFor(cloneDir, config);
  const machineConfig = loadMachineConfig();
  const runtimes = runtimesFrom(machineConfig.runtimes);
  const unknown = [
    ...new Set(
      [workflow, ...Object.values(routeWorkflows)].flatMap((w) =>
        unknownRuntimes(runtimeRefs(config, w.steps), runtimes),
      ),
    ),
  ];
  if (unknown.length) throw new Error(unknown.join("\n"));
  // Every minion is checked at boot: a bad file stops the watcher, not its first run.
  const loaded = loadMinions(cloneDir, config);
  if (loaded.problems.length) throw new Error(loaded.problems.join("\n"));
  const state = new FactoryState(stateDbPath(config.repo));
  const github = makeScm(config);
  // This process, as leases and the spend ledger name it.
  const holder = `${hostname()}-${process.pid}`;
  return {
    workflow,
    routeWorkflows,
    runtimes,
    runFiles: { transcript: (n) => transcriptPath(config.repo, n), live: (n) => livePath(config.repo, n) },
    ...(tmux ? { view: tmuxIssueView(tmux, config.repo, selfCommand()) } : {}),
    github,
    git: new Git(new GitCommandRunner()),
    state,
    bus: watcherBus(state, config),
    minions: loaded.minions,
    blobs: blobStoreFromEnv(),
    executor: new CommandExecutor(
      config.agents,
      config.stages,
      config.routes,
      undefined,
      agentVm(machineConfig),
      machineGateway(machineConfig),
      tokenEnvNames(config, machineConfig),
    ),
    gateRunner: new ShellGateRunner(runtimes[config.runtime?.gates ?? "local"]),
    holdoutRunner: new ShellHoldoutRunner(),
    rechecker: new DiffAnchorRechecker(),
    proofGit: new ShellProofGit(),
    cloneDir,
    workspacesDir: flag("workspaces") ?? defaultWorkspacesDir(process.env, config.repo),
    setupRunner: new ShellSetupRunner(),
    // Every CLI invocation shares FACTORY_HOME/machine.db, so a second repo's watcher here is respected.
    machine: { leases: new MachineLeases(), config: machineConfig, spend: new MachineSpend() },
    // Issue leases on the repo's own remote, so watchers on other machines,
    // CI jobs and cloud routines driving the same repo never run one issue twice.
    leases: { port: new GitLeases(cloneDir), holder, held: new Map() },
    // Spend on the issue and the ledger issue, so caps hold across all of them too.
    spend: new GitHubSpend(github, config.repo, holder),
    spendPolicy: spendPolicy(),
  };
}

async function cmdWatch(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  await requireTmux(config);
  const deps = await buildWatchDeps(cloneDir, config);
  console.log(`factory watch: polling ${config.repo} every ${config.pollIntervalSeconds}s`);
  // Re-drive anything a crashed or previously-killed process left sitting in
  // a running label before the first poll — otherwise it just sits there,
  // since none of pollOnce's resume paths look for a running label (audit
  // finding #21).
  const recovered = await recoverInFlight(deps, config);
  if (recovered.length) console.log(`factory watch: recovered #${recovered.join(", #")}`);
  if (has("once")) {
    const result = await pollOnce(deps, config);
    console.log(has("json") ? successJson(result, !result.paused) : JSON.stringify(result, null, 2));
    if (result.paused) process.exit(EXIT.paused);
    return;
  }
  startWatch(deps, config, (r) => {
    if (r.paused) console.log(`factory watch: paused — ${r.reason}`);
    else if (r.processed.length) console.log(`factory watch: processed #${r.processed.join(", #")}`);
  });
  console.log("factory watch: running. Ctrl+C to stop.");
  await new Promise(() => {}); // keep the process alive
}

// One issue, one pass, then exit — what a CI step calls (`factory run --issue
// N --repo-dir .`), and the stateless counterpart to `watch`'s long-lived
// poll (plan's "Core refactor" advanceIssue entry point).
// `--issue N`, or `--pr N` for an event on a PR (a comment or a review), which
// names the PR, not the issue it works on. Undefined: a PR about no one issue.
async function issueFromFlags(github: ScmPort, repo: string, cmd: string): Promise<number | undefined> {
  const pr = Number(flag("pr"));
  if (pr) return issueOfPr(await github.getPr(repo, pr));
  const issue = Number(flag("issue"));
  if (!issue) throw new UsageError(`${cmd}: --issue <N> or --pr <N> is required`);
  return issue;
}

async function cmdRun(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const issueNumber = await issueFromFlags(makeScm(config), config.repo, "run");
  if (issueNumber === undefined) {
    console.log(`factory run: PR #${flag("pr")} is not about one issue; nothing to do.`);
    return;
  }
  const deps = await buildWatchDeps(cloneDir, config);
  const issue = await deps.github.getIssue(config.repo, issueNumber);
  const outcome = await advanceIssue(deps, config, issue);
  if (has("json")) console.log(successJson({ issue: issueNumber, outcome }, outcome !== "failed"));
  else console.log(`factory run #${issueNumber}: ${outcome}`);
  if (outcome === "failed") process.exit(EXIT.runFailed);
}

// A single poll pass across every open, factory-owned label, then exit —
// what a cron trigger calls instead of holding a process open (plan section
// "Run anywhere" — CI has no long-lived watcher).
async function cmdTick(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const deps = await buildWatchDeps(cloneDir, config);
  const result = await pollOnce(deps, config);
  console.log(has("json") ? successJson(result, !result.paused) : JSON.stringify(result, null, 2));
  if (result.paused) process.exit(EXIT.paused);
}

// Called from a CI failure step: the workflow itself already knows the run
// blew up (a timeout, a runner crash, an out-of-budget stage) in a way
// nothing inside the loop caught, so this parks the issue from the outside
// rather than leaving it stuck on a running label with no explanation.
async function cmdPark(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const reason = flag("reason") ?? "parked by CI (no reason given)";
  const github = makeScm(config);
  const issueNumber = await issueFromFlags(github, config.repo, "park");
  if (issueNumber === undefined) return;
  const issue = await github.getIssue(config.repo, issueNumber);
  const runningLabels: string[] = [LABEL.triaging, LABEL.planning, LABEL.building, LABEL.verifying, LABEL.inReview];
  const current = issue.labels.map((l) => l.name).find((n) => runningLabels.includes(n));
  if (current) await github.setStateLabel(config.repo, issueNumber, [current], LABEL.needsHuman);
  await github.commentIssue(config.repo, issueNumber, `Parked by \`factory park\`: ${reason}`);
  console.log(`factory park #${issueNumber}: needs-human — ${reason}`);
}

async function cmdLogs(): Promise<void> {
  const issue = Number(args[1]);
  if (!Number.isInteger(issue) || issue < 1)
    throw new UsageError("logs: an issue number is required, e.g. `factory logs 12 --follow`");
  const repoDir = flag("repo-dir");
  // With no --repo/--repo-dir/FACTORY_REPO hint, this stays on the legacy
  // shared DB (pre-v2.6.2 installs); with one, it opens that repo's own DB
  // (per-repo since v2.6.2) instead of guessing at the shared one.
  const repo =
    flag("repo") ?? process.env.FACTORY_REPO ?? (repoDir ? (await loadConfig(resolve(repoDir))).repo : undefined);
  const state = new FactoryState(
    flag("db") ?? process.env.FACTORY_DB_PATH ?? (repo ? defaultStatePath(process.env, repo) : DEFAULT_DB_PATH),
  );
  const resolvedRepo = repo ?? state.listRuns().find((r) => r.issue === issue)?.repo ?? "";
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  await streamLogs(state, resolvedRepo, issue, {
    follow: has("follow"),
    stage: flag("stage"),
    json: has("json"),
    signal: controller.signal,
  });
}

async function cmdView(): Promise<void> {
  const file = args[1];
  if (!file)
    throw new UsageError(
      "view: a stream file is required, e.g. `factory view ~/.factory/<owner>/<repo>/transcripts/issue-12.stream.jsonl --follow`",
    );
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  await followStream(file, (text) => process.stdout.write(text), { follow: has("follow"), signal: controller.signal });
}

async function cmdInbox(): Promise<void> {
  // --repo-dir reads the repo's config, so a non-GitHub tracker is asked; --repo alone means GitHub.
  const repoDir = flag("repo-dir");
  const config = repoDir ? await loadConfig(resolve(repoDir)) : undefined;
  const repo = flag("repo") ?? process.env.FACTORY_REPO ?? config?.repo;
  if (!repo) throw new UsageError("inbox: --repo <owner/name>, --repo-dir <path> or FACTORY_REPO is required");
  const github = makeScm(config ?? DEFAULT_CONFIG);
  // Only read the watcher's DB if it exists; the inbox must not create one.
  const db = flag("db") ?? process.env.FACTORY_DB_PATH ?? defaultStatePath(process.env, repo);
  const reasons = existsSync(db) ? parkReasons(new FactoryState(db).listRuns(repo)) : undefined;
  const items = [
    ...buildInbox(await github.listOpenIssues(repo), reasons),
    ...prItems(await github.listPrs(repo, { state: "open" })),
  ];
  const [issueArg, actionArg] = inboxPositionals(args);
  if (issueArg) {
    const item = items.find((i) => i.issue === Number(issueArg));
    if (!item) throw new UsageError(`inbox: #${issueArg} is not waiting for you`);
    if (!actionArg) throw new UsageError(`inbox: choose an action: ${item.actions.join(", ")}`);
    const posted = await act(github, repo, item, actionArg as InboxAction, flag("text") ?? "");
    console.log(has("json") ? successJson({ issue: item.issue, posted }, true) : `#${item.issue}: posted "${posted}"`);
    return;
  }
  if (has("json")) console.log(successJson({ items }, true));
  else if (!items.length) console.log("Nothing is waiting for you.");
  else for (const i of items) console.log(`#${i.issue} ${i.kind} (${i.actions.join("/")}): ${i.title}`);
}

async function cmdScan(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  // scan shells out to osv-scanner, or to `bun audit` without it: not `git`, so its own runner.
  const runner = {
    run: async (argv: string[], opts?: { cwd?: string }) => {
      if (!Bun.which(argv[0]!)) return { stdout: "", stderr: `${argv[0]}: not installed`, code: 127 };
      const proc = Bun.spawn(argv, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, code };
    },
  };
  const report = flag("lighthouse");
  const result = report
    ? await scanLighthouse(makeScm(config), config.repo, await Bun.file(report).text())
    : await scan({ github: makeScm(config), runner }, config.repo, cloneDir);
  if (result.skippedReason) {
    console.log(`factory scan: skipped — ${result.skippedReason}`);
    return;
  }
  console.log(
    `factory scan (${result.source}): filed ${result.filed.length}, skipped ${result.skipped.length} (already open)`,
  );
  for (const t of result.filed) console.log(`  + ${t}`);
}

async function cmdReset(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const dryRun = has("dry-run");
  const ctx = {
    repo: config.repo,
    cloneDir,
    baselineTag: config.baselineTag,
    base: config.base,
    issuesDir: `${cloneDir}/.factory/issues`,
    workspacesDir: flag("workspaces") ?? defaultWorkspacesDir(process.env, config.repo),
    statePath: flag("db") ?? process.env.FACTORY_DB_PATH ?? defaultStatePath(process.env, config.repo),
    resettable: config.resettable,
    allIssues: has("all-issues"),
  };
  const deps = { github: makeScm(config), git: new GitCommandRunner() };
  const summary = await reset(deps, ctx, dryRun);
  console.log(`factory reset${dryRun ? " --dry-run" : ""}: ${summary.actions.length} action(s)`);
  for (const a of summary.actions) console.log(`  ${dryRun ? "would " : ""}${a.kind}: ${a.detail}`);
}

async function cmdRebaseline(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const dryRun = has("dry-run");
  const ctx = {
    repo: config.repo,
    cloneDir,
    baselineTag: config.baselineTag,
    base: config.base,
    issuesDir: "",
    workspacesDir: "",
    statePath: "",
    resettable: config.resettable,
  };
  const moved = await rebaseline({ github: makeScm(config), git: new GitCommandRunner() }, ctx, dryRun);
  console.log(
    `factory rebaseline${dryRun ? " --dry-run" : ""}: ${config.baselineTag} -> origin/${config.base} (${moved.length} commit(s))`,
  );
  for (const c of moved) console.log(`  ${c}`);
}

// The skills this runner ships, keyed by their path in a target repo.
function templateSkills(): Record<string, string> {
  const root = resolve(import.meta.dir, "..", "template");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(join(root, ".claude", "skills"));
  return out;
}

async function cmdDoctor(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  let config: FactoryConfig;
  try {
    config = await loadConfig(cloneDir);
  } catch (err) {
    if (has("json"))
      console.log(
        successJson(
          {
            checks: [
              {
                name: ".factory/config.json is usable",
                ok: false,
                detail: err instanceof Error ? err.message : String(err),
                fixable: false,
              },
            ],
          },
          false,
        ),
      );
    else console.log(`  [FAIL] .factory/config.json is usable — ${err instanceof Error ? err.message : err}`);
    process.exit(EXIT.checksFailed);
  }
  const github = makeScm(config);
  const checks = await runDoctor(
    {
      github,
      tracker: { kind: github.trackerKind, authStatus: () => github.tracker.authStatus() },
      git: new GitCommandRunner(),
      which,
      versionOf,
      fileExists,
      readFile: async (path) => ((await fileExists(path)) ? await Bun.file(path).text() : undefined),
      probeRuntime: (name) => probeRuntime(runtimesFrom(loadMachineConfig().runtimes)[name]!, 10_000),
      isExecutable: async (path) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      repo: config.repo,
      cloneDir,
      baselineTag: config.baselineTag,
      factoryMode: process.env.FACTORY_MODE,
      agents: config.agents,
      stages: config.stages,
      routes: config.routes,
      templateSkills: templateSkills(),
      templateOverrides: config.templateOverrides,
      workflow: config.workflow,
      runtime: config.runtime,
      runtimeNames: Object.keys(runtimesFrom(loadMachineConfig().runtimes)),
      tmux: config.tmux.enabled,
      legacyStatePath: defaultStatePath(process.env),
      legacyWorkspacesDir: defaultWorkspacesDir(process.env),
      configuredSlots: loadMachineConfig().slots,
      resettable: config.resettable,
    },
  );
  const allOk = checks.every((c) => c.ok || c.warn);
  if (has("json")) console.log(successJson({ checks }, allOk));
  else for (const c of checks) console.log(`  [${c.ok ? "ok" : c.warn ? "warn" : "FAIL"}] ${c.name} — ${c.detail}`);
  if (!allOk && has("fix")) {
    console.error("factory doctor --fix: creating missing labels");
    await fixDoctor(github, config.repo, config.routes, await workflowFor(cloneDir, config).catch(() => undefined));
  }
  if (!allOk && !has("fix")) process.exit(EXIT.checksFailed);
}

// `dashboard/server.ts`'s own `if (import.meta.main)` block never fires
// here: this file is the process entry point, so that module is always
// imported, not run directly. Call createDashboard + Bun.serve ourselves,
// mirroring that block exactly (audit finding #16): loopback by default,
// and remoteAddress passed through so handle() can enforce it. Shared by
// `dashboard` (cockpit only, any mode) and `up` (Docker's single-process
// entrypoint: watch + dashboard together).
function serveDashboard(
  state: FactoryState,
  github: ScmPort,
  repo: string,
  autoApproveDefault = false,
  fleet?: Pick<FactoryConfig, "agents" | "stages">,
  project?: DashboardProject,
): number {
  const port = Number(flag("port") ?? process.env.FACTORY_DASHBOARD_PORT ?? 4100);
  const hostname = process.env.FACTORY_DASHBOARD_HOST ?? "127.0.0.1";
  const app = createDashboard(state, github, repo, autoApproveDefault, undefined, fleet, undefined, project, plane());
  const server = Bun.serve({
    port,
    hostname,
    fetch: (req: Request): Promise<Response> => app.handle(req, server.requestIP(req)?.address),
  });
  console.log(`factory dashboard: http://${hostname}:${port} (repo=${repo || "unset"})`);
  app.remote.start();
  return port;
}

// The repo the Workflows and Settings pages describe.
function dashboardProject(cloneDir: string, config: FactoryConfig): DashboardProject {
  const leases = new GitLeases(cloneDir);
  return { cloneDir, config, machine: loadMachineConfig(), leases: () => leases.held(), fleet: new MachineLeases() };
}

async function cmdDashboard(): Promise<void> {
  const repoDir = flag("repo-dir");
  const config = repoDir ? await loadConfig(resolve(repoDir)) : undefined;
  const repo = flag("repo") ?? process.env.FACTORY_REPO ?? config?.repo ?? "";
  const dbPath =
    flag("db") ?? process.env.FACTORY_DB_PATH ?? (repo ? defaultStatePath(process.env, repo) : DEFAULT_DB_PATH);
  const state = new FactoryState(dbPath);
  const github = makeScm(config ?? DEFAULT_CONFIG);
  serveDashboard(
    state,
    github,
    repo,
    false,
    config,
    repoDir && config ? dashboardProject(resolve(repoDir), config) : undefined,
  );
  await new Promise(() => {}); // keep the process alive
}

// The Docker image's entrypoint command (plan "Run anywhere", VM mode):
// `docker run ... kaas-factory up --repo owner/name`. One process, one
// PID 1, running both the poll loop and the cockpit — a container only gets
// to hold open one foreground process, unlike `make up`'s two background
// shells on a laptop.
async function cmdUp(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  await requireTmux(config);
  if (has("tmux")) return upInTmux(cloneDir, config);
  const deps = await buildWatchDeps(cloneDir, config);
  const recovered = await recoverInFlight(deps, config);
  if (recovered.length) console.log(`factory up: recovered #${recovered.join(", #")}`);
  startWatch(deps, config, (r) => {
    if (r.paused) console.log(`factory up: paused — ${r.reason}`);
    else if (r.processed.length) console.log(`factory up: processed #${r.processed.join(", #")}`);
  });
  serveDashboard(
    deps.state,
    deps.github,
    config.repo,
    config.riskPolicy.autoApproveLowRisk,
    config,
    dashboardProject(cloneDir, config),
  );
  console.log(`factory up: polling ${config.repo} every ${config.pollIntervalSeconds}s. Ctrl+C to stop.`);
  await new Promise(() => {}); // keep the process alive
}

// This CLI as a shell command, for the tmux windows it opens.
function selfCommand(): string {
  return [process.execPath, Bun.main].map(shellQuote).join(" ");
}

// `up --tmux`: the watcher and the dashboard each get a window in the
// session, and every issue in flight gets its own beside them. Detached, so
// it works the same over SSH or `docker exec`; `factory attach` joins it.
async function upInTmux(cloneDir: string, config: FactoryConfig): Promise<void> {
  const tmux = new Tmux(new ShellTmuxRunner(), config.tmux.session);
  const self = selfCommand();
  const pass = ["db", "workspaces"].flatMap((f) => (flag(f) ? [`--${f}`, shellQuote(flag(f)!)] : [])).join(" ");
  const repoDir = `--repo-dir ${shellQuote(cloneDir)}`;
  await tmux.ensureWindow("watch", `${self} watch ${repoDir} --tmux ${pass}`.trim(), cloneDir);
  await tmux.ensureWindow("dashboard", `${self} dashboard ${repoDir} ${pass}`.trim(), cloneDir);
  console.log(`factory up: tmux session "${config.tmux.session}" has windows watch and dashboard.`);
  console.log(`attach: factory attach --repo ${config.repo}   (or: tmux attach -t ${config.tmux.session})`);
}

// The repo slug without cloning: --repo as given, else the config in --repo-dir.
async function repoSlugAndConfig(): Promise<{ repo: string; config?: FactoryConfig }> {
  const repoDir = flag("repo-dir");
  const config = repoDir ? await loadConfig(resolve(repoDir)) : undefined;
  const repo = flag("repo") ?? config?.repo;
  if (!repo) throw new UsageError("--repo <owner/name> or --repo-dir <path> is required");
  return { repo, config };
}

async function cmdAttach(): Promise<void> {
  const n = args[1] && !args[1].startsWith("--") ? Number(args[1]) : undefined;
  const { repo, config } = await repoSlugAndConfig();
  const session = flag("session") ?? config?.tmux.session ?? "factory";
  const tmux = new Tmux(new ShellTmuxRunner(), session);
  if (!(await tmux.hasSession())) throw new Error(`no tmux session "${session}": start one with factory up --tmux`);
  if (n) {
    const name = issueWindow(repo, n);
    if (!(await tmux.windows()).includes(name))
      throw new Error(`#${n} has no window in "${session}" (no stage has run since the watcher started)`);
    await new ShellTmuxRunner().run(["select-window", "-t", `=${session}:=${name}`]);
  }
  // Inside tmux already: switch this client instead of nesting a second one.
  const argv = process.env.TMUX
    ? ["tmux", "switch-client", "-t", `=${session}`]
    : ["tmux", "attach", "-t", `=${session}`];
  process.exit(await Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited);
}

// Waits for the watcher to park the issue after a takeover, so the hand-back
// retry lands on a parked issue and never races the stage it stopped.
async function waitForLabel(
  github: ScmPort,
  repo: string,
  n: number,
  label: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const issue = await github.getIssue(repo, n);
    if (issue.labels.some((l) => l.name === label)) return true;
    if (Date.now() > end) return false;
    await Bun.sleep(2000);
  }
}

// `daemon install|uninstall`: `factory up` for this repo in the background,
// at login, restarted when it exits (src/daemon.ts).
async function cmdDaemon(): Promise<void> {
  const action = args[1];
  if (action !== "install" && action !== "uninstall")
    throw new UsageError(
      "daemon: usage: factory daemon (install | uninstall) (--repo-dir <path> | --repo <owner/name>)",
    );
  const platform = daemonPlatform(process.platform);
  if (!platform)
    throw new Error(
      `daemon: no launchd or systemd on ${process.platform}; run \`factory up\` under your own supervisor`,
    );
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const home = homedir();
  const uid = process.getuid?.() ?? 0;
  const runner = {
    run: async (argv: readonly string[]) => {
      const p = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe" });
      return { exitCode: await p.exited, stderr: await new Response(p.stderr).text() };
    },
  };
  if (action === "uninstall") {
    console.log(`factory daemon: removed ${await uninstallDaemon(platform, home, config.repo, uid, runner)}`);
    return;
  }
  const pass = ["db", "workspaces"].flatMap((f) => (flag(f) ? [`--${f}`, flag(f)!] : []));
  const argv = [process.execPath, Bun.main, "up", "--repo-dir", cloneDir, ...pass];
  const logDir = join(factoryHome(), "logs");
  const file = await installDaemon(
    platform,
    { repo: config.repo, argv, workdir: cloneDir, logDir, path: process.env.PATH ?? "/usr/bin:/bin", home },
    uid,
    runner,
  );
  console.log(`factory daemon: ${platform} runs \`factory up\` for ${config.repo} from ${file}; logs in ${logDir}`);
}

async function cmdTakeover(): Promise<void> {
  const n = Number(args[1]);
  if (!n)
    throw new UsageError(
      "takeover: usage: factory takeover <N> (--repo-dir <path> | --repo <owner/name>) [--no-handback]",
    );
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const repo = config.repo;
  const worktree = `${flag("workspaces") ?? defaultWorkspacesDir(process.env, repo)}/issue-${n}`;
  if (!(await Bun.file(`${worktree}/.git`).exists())) throw new Error(`#${n} has no worktree at ${worktree}`);
  const github = makeScm(config);
  const liveFile = livePath(repo, n);
  const live = readLive(liveFile);
  let agent: string;
  let sessionId: string | undefined;
  if (live) {
    console.log(`factory takeover: stopping ${live.stage} on #${n} (pid ${live.pid})`);
    if (!(await stopRunningStage(liveFile, live)))
      throw new Error(`#${n}: the ${live.stage} stage did not stop within 60s`);
    if (!(await waitForLabel(github, repo, n, LABEL.needsHuman)))
      throw new Error(`#${n} was stopped but not parked within 60s; is the watcher running?`);
    agent = live.agent;
    sessionId = live.sessionId;
  } else {
    const state = new FactoryState(flag("db") ?? process.env.FACTORY_DB_PATH ?? defaultStatePath(process.env, repo));
    const last = state.lastSession(repo, n);
    state.close();
    agent = last?.agent ?? config.stages.default ?? "claude";
    sessionId = last?.session_id;
  }
  if (!sessionId) throw new Error(`agent ${agent} cannot be resumed: no session recorded for #${n}`);
  const argv = resumeArgv(agent, config.agents, sessionId);
  for (const line of takeoverBanner(argv, worktree)) console.log(line);
  await Bun.spawn(argv, { cwd: worktree, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited;
  if (has("no-handback")) {
    console.log(`factory takeover: #${n} left as it is; hand back with: factory inbox ${n} retry --repo ${repo}`);
    return;
  }
  const item = buildInbox([await github.getIssue(repo, n)])[0];
  if (item?.actions.includes("retry")) {
    const posted = await act(github, repo, item, "retry");
    console.log(`factory takeover: handed #${n} back ("${posted}")`);
  } else if (item) {
    console.log(
      `factory takeover: #${n} is waiting on you (${item.kind}); choose: factory inbox ${n} <${item.actions.join("|")}> --repo ${repo}`,
    );
  } else {
    console.log(`factory takeover: #${n} is not parked; nothing to hand back`);
  }
}

// Runs the whole loop for one issue on one preset, with the raw output recorded as a fixture.
async function cmdVerifyAgent(): Promise<void> {
  const name = args[1];
  if (!name || name.startsWith("--")) throw new UsageError("verify-agent: <name> is required");
  const cloneDir = await resolveCloneDir();
  const issueNumber = Number(flag("issue"));
  if (!issueNumber) throw new UsageError("verify-agent: --issue <N> is required");
  const loaded = await loadConfig(cloneDir);
  const config: FactoryConfig = { ...loaded, ...configFor(name) };
  const out = flag("out") ? resolve(flag("out")!) : defaultFixtureDir(name);
  const deps = {
    ...(await buildWatchDeps(cloneDir, config)),
    executor: new CommandExecutor(config.agents, config.stages, config.routes, new FixtureRecorder(out, name)),
  };
  const outcome = await advanceIssue(deps, config, await deps.github.getIssue(config.repo, issueNumber));
  if (outcome === "awaiting-approval") {
    console.log(
      `Plan gate: read the plan on #${issueNumber}, approve it (/factory approve), then run this command again to finish and record the rest.`,
    );
  }
  const report = reportFor(name, deps.state.listStageRuns(config.repo, { issue: issueNumber }), outcome);
  console.log(formatReport(report));
  console.log(`fixture: ${out}`);
  if (!report.pass) process.exit(EXIT.runFailed);
}

async function cmdLearn(): Promise<void> {
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const deps = await buildWatchDeps(cloneDir, config);
  const result = await runLearn(deps, config.repo, config.base);
  if (has("json")) {
    console.log(successJson(result, true));
    return;
  }
  if (result.batched === 0) {
    console.log("factory learn: nothing pending.");
    return;
  }
  console.log(`factory learn: batched ${result.batched} proposal(s) on ${result.branch} -> ${result.prUrl}`);
}

async function cmdInstall(): Promise<void> {
  const target = args[1];
  if (!target)
    throw new UsageError("install: usage: factory install <target-dir> [--dry-run] [--update] [--ci] [--agents a,b,c]");
  const passthrough = [
    ...(has("dry-run") ? ["--dry-run"] : []),
    ...(has("update") ? ["--update"] : []),
    ...(has("ci") ? ["--ci"] : []),
    ...(flag("agents") ? ["--agents", flag("agents")!] : []),
  ];
  await runInstallScript(target, passthrough);
  if (has("dry-run")) return;
  // Labels are cheap and idempotent, so create them right after a real install
  // instead of making every repo run a separate `doctor --fix` first. Best
  // effort: a fresh install with no filled-in config.json still gets the
  // "next:" hint above, and `doctor --fix` stays the authoritative fixer.
  try {
    const config = await loadConfig(resolve(target));
    await fixDoctor(
      makeScm(config),
      config.repo,
      config.routes,
      await workflowFor(resolve(target), config).catch(() => undefined),
    );
    console.log(`factory install: labels ensured on ${config.repo}`);
  } catch {
    // no usable config.json yet
  }
}

async function runInstallScript(target: string, extra: string[] = []): Promise<void> {
  const proc = Bun.spawn(["bash", resolve(import.meta.dir, "..", "install.sh"), target, ...extra], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) process.exit(code);
}

// `factory init`: install the template if it is missing, then write
// .factory/config.json from what the repo's own files say. A filled-in
// config is left alone unless --force. --pr opens it as one pull request.
async function cmdInit(): Promise<void> {
  const dir = resolve(flag("repo-dir") ?? ".");
  const dry = has("dry-run");
  if (!existsSync(join(dir, ".factory", "gates.sh")) && !dry) await runInstallScript(dir);
  const stack = detectStack(diskFiles(dir));
  for (const line of describeStack(stack)) console.log(`factory init: ${line}`);
  const target = join(dir, ".factory", "config.json");
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (isFilledIn(current) && !has("force")) {
    console.log(`factory init: ${target} is already filled in; left alone (--force rewrites it)`);
    return;
  }
  const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir });
  const repo = remote.exitCode === 0 ? repoFromRemoteUrl(remote.stdout.toString().trim()) : undefined;
  const example = JSON.parse(
    readFileSync(resolve(import.meta.dir, "..", "template", ".factory", "config.example.json"), "utf8"),
  ) as Record<string, unknown>;
  const text = `${JSON.stringify(initConfig(example, stack, repo), null, 2)}\n`;
  if (dry) {
    process.stdout.write(text);
    return;
  }
  await Bun.write(target, text);
  console.log(`factory init: wrote ${target}${repo ? "" : ' (no github origin remote: set "repo" by hand)'}`);
  const charter = readFileSync(resolve(import.meta.dir, "..", "template", ".factory", "charter.md"), "utf8");
  if (writeCharter(dir, charter, stack, repo))
    console.log(`factory init: wrote ${join(dir, ".factory", "charter.md")}`);
  if (has("pr")) {
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr.toString().trim()}`);
    };
    git("switch", "-c", "factory/init");
    git("add", "-A", ".factory", ".claude", ".agents", "AGENTS.md");
    git("commit", "-m", `factory: init for a ${stack.name} repo`);
    git("push", "-u", "origin", "factory/init");
    const pr = Bun.spawnSync(
      [
        "gh",
        "pr",
        "create",
        "--head",
        "factory/init",
        "--title",
        "factory: init",
        "--body",
        describeStack(stack)
          .map((l) => `- ${l}`)
          .join("\n"),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (pr.exitCode !== 0) throw new Error(`gh pr create failed: ${pr.stderr.toString().trim()}`);
    console.log(`factory init: opened ${pr.stdout.toString().trim()}`);
  }
  console.log(
    `factory init: next, fill the TODOs in .factory/charter.md, then run \`factory doctor --repo-dir ${dir}\``,
  );
}

// `factory harness validate|inventory`: the repo's workflows, checked as the watcher loads them, or listed.
async function cmdHarness(): Promise<void> {
  const sub = args[1];
  if (sub !== "validate" && sub !== "inventory")
    throw new UsageError("usage: factory harness (validate | inventory) --repo-dir <path> [--json]");
  const dir = resolve(flag("repo-dir") ?? ".");
  const report = await harnessReport(dir, await loadConfig(dir));
  if (has("json")) {
    console.log(
      successJson(
        {
          problems: report.problems,
          workflows: report.entries.map(({ workflow, ...e }) => ({
            ...e,
            steps: workflow ? Object.keys(workflow.steps) : [],
          })),
        },
        sub === "inventory" || !report.problems.length,
      ),
    );
  } else if (sub === "inventory") {
    for (const line of formatInventory(report)) console.log(line);
  } else {
    for (const p of report.problems) console.log(`factory harness: ${p}`);
    if (!report.problems.length) console.log(`factory harness: ${report.entries.length} workflows, all valid`);
  }
  if (sub === "validate" && report.problems.length) process.exit(EXIT.checksFailed);
}

// `factory minion list|run <name> [--event <json-file>]`: the repo's minions, or one run now.
async function cmdMinion(): Promise<void> {
  const sub = args[1];
  if (sub !== "list" && sub !== "run")
    throw new UsageError("usage: factory minion (list | run <name> [--event <json-file>]) --repo-dir <path> [--json]");
  if (sub === "list") {
    const dir = resolve(flag("repo-dir") ?? ".");
    const { minions, problems } = loadMinions(dir, await loadConfig(dir));
    if (has("json"))
      console.log(
        successJson(
          {
            problems,
            minions: minions.map((m) => ({
              name: m.name,
              description: m.description,
              on: "event" in m.on ? { event: m.on.event } : { cron: m.on.cron.src, tz: m.on.tz },
              emit: m.emit ?? null,
            })),
          },
          !problems.length,
        ),
      );
    else {
      for (const m of minions)
        console.log(
          `${m.name}  ${"event" in m.on ? `on ${m.on.event}` : `cron ${m.on.cron.src} ${m.on.tz}`}${m.emit ? `  emits ${m.emit}` : ""}  ${m.description}`,
        );
      for (const p of problems) console.log(`factory minion: ${p}`);
      if (!minions.length && !problems.length) console.log("factory minion: no minions in .factory/minions");
    }
    if (problems.length) process.exit(EXIT.checksFailed);
    return;
  }
  const name = args[2];
  if (!name || name.startsWith("--")) throw new UsageError("minion run: a minion name is required");
  const cloneDir = await resolveCloneDir();
  const config = await loadConfig(cloneDir);
  const deps = await buildWatchDeps(cloneDir, config);
  const minion = deps.minions?.find((m) => m.name === name);
  if (!minion) throw new UsageError(`minion run: no minion "${name}" in .factory/minions`);
  let event: Parameters<typeof runMinion>[3];
  const eventFile = flag("event");
  if (eventFile) {
    const parsed = parseEvent(JSON.parse(readFileSync(eventFile, "utf8")));
    if (!parsed.ok) throw new UsageError(`minion run --event: ${parsed.problem}`);
    event = parsed.event;
  }
  const run = await runMinion(deps, config, minion, event);
  await deps.bus?.deliver();
  console.log(has("json") ? successJson(run, run.status === "ok") : JSON.stringify(run, null, 2));
  if (run.status !== "ok") process.exit(EXIT.checksFailed);
}

// `factory events tail|replay <id>`: the outbox and inbox, newest last, or one event sent again.
async function cmdEvents(): Promise<void> {
  const sub = args[1];
  if (sub !== "tail" && sub !== "replay")
    throw new UsageError("usage: factory events (tail [--limit N] | replay <id>) --repo-dir <path> [--json]");
  const cloneDir = resolve(flag("repo-dir") ?? ".");
  const config = await loadConfig(cloneDir);
  const state = new FactoryState(stateDbPath(config.repo));
  if (sub === "tail") {
    const rows = state.busEvents(Number(flag("limit") ?? 50));
    for (const r of rows) {
      if (has("json"))
        console.log(JSON.stringify({ ...r, data: JSON.parse(r.data), deliveries: state.busDeliveries(r.id) }));
      else
        console.log(
          `${r.time}  ${r.direction === "in" ? "<-" : "->"}  ${r.type}  ${r.id}${r.subject ? `  ${r.subject}` : ""}${state
            .busDeliveries(r.id)
            .map((d) => `  [${d.status} ${d.sink}]`)
            .join("")}`,
        );
    }
    return;
  }
  const id = args[2];
  if (!id || id.startsWith("--")) throw new UsageError("events replay: an event id is required");
  const bus = new EventBus({
    store: state,
    sinks: config.events.sinks,
    source: `factory/${config.repo}`,
    autoDeliver: false,
  });
  const queued = bus.replay(id);
  if (!queued) throw new UsageError(`events replay: no event "${id}" with a configured sink`);
  const delivered = await bus.deliver();
  console.log(`factory events: ${id} queued to ${queued} sink(s), ${delivered} delivered now`);
}

// `factory receipt`: the key that signs acceptance receipts, and a quick check of one. The independent check
// is verify/ (kaas-verify), which a reviewer runs with no factory code; see docs/receipts.md.
async function cmdReceipt(): Promise<void> {
  const sub = args[1];
  if (sub === "keygen") {
    const out = flag("out");
    if (!out) throw new Error("usage: factory receipt keygen --out <key.pem>");
    if (existsSync(out)) throw new Error(`${out} exists; a new key would orphan every receipt it signed`);
    const { privateKeyPem, publicKeyPem } = generateReceiptKey();
    writeFileSync(out, privateKeyPem, { mode: 0o600 });
    writeFileSync(`${out}.pub`, publicKeyPem);
    if (has("json")) console.log(successJson({ key: out, pub: `${out}.pub`, keyid: keyId(publicKeyPem) }));
    else
      console.log(
        `factory receipt: wrote ${out} (keep it secret) and ${out}.pub (commit it as .factory/receipt.pub)\nset ${RECEIPT_KEY_ENV}=${out} on the runner`,
      );
    return;
  }
  if (sub === "verify" && args[2]) {
    const pub = flag("pubkey");
    if (!pub) throw new Error("usage: factory receipt verify <receipt.dsse.json> --pubkey <key.pub>");
    const envelope = JSON.parse(readFileSync(args[2], "utf8")) as Envelope;
    const ok = verifyEnvelope(envelope, readFileSync(pub, "utf8"));
    const { verdict } = decodeStatement(envelope).predicate;
    if (has("json")) console.log(successJson({ signed: ok, ...verdict }));
    else console.log(`${ok ? "signed" : "NOT SIGNED by this key"}; ${verdict.proven ? "proven" : "not proven"}`);
    if (!ok) process.exit(EXIT.error);
    return;
  }
  console.log(
    "usage: factory receipt (keygen --out <key.pem> | verify <receipt.dsse.json> --pubkey <key.pub>) [--json]",
  );
  if (!has("help")) process.exit(EXIT.error);
}

async function main(): Promise<void> {
  switch (command) {
    case "up":
      return flag("repo") || flag("repo-dir") ? cmdUp() : (await import("./deploy/stack")).startStack(cmdDashboard);
    case "init":
      return cmdInit();
    case "watch":
      return cmdWatch();
    case "run":
      return cmdRun();
    case "tick":
      return cmdTick();
    case "park":
      return cmdPark();
    case "dashboard":
      return cmdDashboard();
    case "logs":
      return cmdLogs();
    case "view":
      return cmdView();
    case "inbox":
      return cmdInbox();
    case "scan":
      return cmdScan();
    case "reset":
      return cmdReset();
    case "rebaseline":
      return cmdRebaseline();
    case "doctor":
      return cmdDoctor();
    case "install":
      return cmdInstall();
    case "verify-agent":
      return cmdVerifyAgent();
    case "learn":
      return cmdLearn();
    case "attach":
      return cmdAttach();
    case "takeover":
      return cmdTakeover();
    case "daemon":
      return cmdDaemon();
    case "harness":
      return cmdHarness();
    case "minion":
      return cmdMinion();
    case "events":
      return cmdEvents();
    case "pool":
      return cmdPool(cli);
    case "runtime":
      return cmdRuntime(cli);
    case "dispatch":
      return cmdDispatch(cli);
    case "routine":
      return cmdRoutine(cli);
    case "receipt":
      return cmdReceipt();
    case "mcp":
    case "runner":
    case "pair":
      return remoteCommand(args);
    default:
      console.log(helpText());
      if (command && !["help", "--help", "-h"].includes(command)) process.exit(EXIT.error);
  }
}

try {
  await main();
} catch (err) {
  if (has("json")) console.error(failureJson(err));
  else console.error(`factory: ${plain(err instanceof Error ? err.message : String(err))}`);
  process.exit(EXIT.error);
}
