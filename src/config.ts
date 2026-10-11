// Ported from owainlewis/assembler@7cac671 src/index.ts:64-90 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: validateConfig's harness rules (executable not a {prompt} placeholder, a command must be non-empty) live in agentProblems; the codex/claude providers are presets; errors are collected, not thrown one at a time; the key table, boot refusal and defaults are the factory's own.
// Shape of the target repo's `.factory/config.json`. Built by the repo-specific
// side (splitbill) or by whoever installs this template elsewhere; the runner
// only reads it, and `factory doctor` checks it exists. Missing fields fall
// back to DEFAULT_CONFIG so a minimal config.json still works.

import { existsSync } from "node:fs";
import { PRESETS } from "./agents/presets";
import { githubHost } from "./repo";
import type { AgentConfig, StageAgents } from "./agents/types";
import { LABEL } from "./labels";

export interface RiskPolicy {
  // Low risk (docs, test-only, a single non-protected module) is eligible for
  // auto-approve; the toggle in state.ts still has to be on.
  readonly autoApproveLowRisk: boolean;
  // The highest plan risk that may skip the plan gate when the switch above is on.
  readonly autoApproveMaxRisk: "low" | "medium";
}

export interface StageBudgets {
  readonly triage: number;
  readonly plan: number;
  readonly build: number;
  readonly verify: number;
  readonly pr: number;
  readonly retro: number;
}

// Extra Bash patterns the repo grants its agents, on top of the read-only
// git and shell basics in stage-permissions.ts. `read` applies to every
// stage; `build` and `verify` add to that stage only. Each entry is a bare
// pattern such as "make *" or "npm test *", never a compound command.
export interface AgentCommands {
  readonly read: readonly string[];
  readonly build: readonly string[];
  readonly verify: readonly string[];
}

// One gate `.factory/gates.sh` runs. `required: false` reports but never fails the build.
export interface GateSpec {
  readonly name: string;
  readonly cmd: string;
  readonly required: boolean;
  // What the gate checks. The proof reverts the change and runs the `test` one.
  readonly role?: GateRole;
}

// A package in a monorepo: its gates run from its own directory, and only when
// the diff touches a file under `path` (or `always` is set). Top-level gates always run.
export interface PackageSpec {
  readonly path: string; // relative to the repo root, e.g. "packages/api"
  readonly gates: readonly GateSpec[];
  readonly always?: boolean;
}

// The one count of gates a config defines, top-level and per package. Doctor,
// init and the build step's no-gates check all read it. Unparsable is 0.
export function gateCount(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return 0;
  const cfg = raw as { gates?: unknown; packages?: unknown };
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const packages = Array.isArray(cfg.packages) ? cfg.packages : [];
  return n(cfg.gates) + packages.reduce((sum: number, p) => sum + n((p as { gates?: unknown } | null)?.gates), 0);
}

export const GATE_ROLES = ["test", "lint", "typecheck", "build", "format", "audit", "docs"] as const;
export type GateRole = (typeof GATE_ROLES)[number];

// The one resolver for "the test gate": the gate with role test, else one named test.
export function testGate(gates: readonly GateSpec[]): GateSpec | undefined {
  return gates.find((g) => g.role === "test") ?? gates.find((g) => g.name === "test");
}

// A route for one issue type (a label: the five in TYPE_LABELS, or one a repo
// adds, e.g. lwp's "content"). `resolveRoute` (src/agents/executor.ts) checks
// `stages[stage]` here before falling back to the repo-wide `stages`. Triage
// runs before the type is known, so it never consults a route.
export interface RouteConfig {
  readonly stages?: Partial<StageAgents>;
  readonly skills?: readonly string[];
  // "test" (default): build writes a failing test first, verify checks it
  // catches the bug. "check": build runs the named commands instead of a
  // test, verify re-runs them and a reviewer judges the diff (plan v2.7.0
  // item 8: a blog post can only ever end uncertain/reject under "test").
  readonly proof?: "test" | "check";
  // A workflow in .factory/workflows/ (or bundled) this type runs instead of the repo's.
  readonly workflow?: string;
}

export interface FactoryConfig {
  readonly repo: string; // "owner/name"
  readonly protectedPaths: readonly string[]; // globs the guard hook and triage refuse
  readonly postEditCommand: readonly string[]; // argv the post-edit-check hook runs on each build edit; {file} is the path; [] is off
  readonly riskPolicy: RiskPolicy;
  readonly maxOpenFactoryPrs: number; // STOP_IF threshold (plan section 9: 3)
  readonly concurrency: number; // worktrees in flight at once
  readonly pollIntervalSeconds: number;
  readonly maxBudgetUsd: StageBudgets;
  readonly baselineTag: string; // reset.ts forces main to this tag's SHA
  readonly base: string; // base branch for PRs, usually "main"
  readonly stageTimeoutMinutes: number; // kills a stuck `claude` process (audit finding #15)
  readonly maxToolCalls: number; // kills a runaway stage before it burns budget
  readonly gates: readonly GateSpec[]; // read by .factory/gates.sh
  // Monorepo packages, each with its own gates; see PackageSpec.
  readonly packages?: readonly PackageSpec[];
  // Opt-in: `reset`/`rebaseline` refuse on any repo where this is false (the
  // default), so a live repo (lwp-website) can never be force-pushed back to
  // a baseline tag by a stray `factory reset` (plan v2.6.2 item 2).
  readonly resettable: boolean;
  // Commands run once per fresh worktree, before any stage (e.g. "npm ci").
  // Idempotent via a marker file in the worktree; a failure parks the issue.
  readonly setup: readonly string[];
  readonly agentCommands: AgentCommands;
  // Named agents, each a preset or a command; `stages` says which one runs a stage.
  readonly agents: Readonly<Record<string, AgentConfig>>;
  readonly stages: StageAgents;
  // Per-type overrides, keyed by the type label. See RouteConfig.
  readonly routes: Readonly<Record<string, RouteConfig>>;
  // Checked before every stage (plan v2.7.0 item 7). perIssueUsd is that
  // issue's own lifetime spend; dailyUsd is this repo's spend since 00:00 UTC
  // today. Either breached parks the issue with a "budget" inbox item.
  // maxUnreportedRuns caps the count of stage runs with unknown cost (no
  // price, no self-reported total) on one issue — a separate cap from the
  // dollar ones, since an unpriced run can't be summed into them.
  readonly spend: SpendConfig;
  readonly merge: MergeConfig;
  readonly holdout: HoldoutConfig;
  // One tmux window per issue in flight, tailing its transcript (`factory attach`).
  readonly tmux: TmuxConfig;
  // Append the "Factory run" section (stages, agents, cost, what needed help) to the PR body.
  readonly prRunSummary: boolean;
  // Installed template files this repo changed on purpose; doctor's drift check skips them.
  readonly templateOverrides: readonly string[];
  // The workflow an issue runs: .factory/workflows/<name>.yml, else the runner's copy.
  readonly workflow: string;
  // Defaults for a company size (PROFILES); any key set explicitly still wins.
  readonly profile?: Profile;
  // Where gates and check steps run, by runtime name (src/runtimes.ts); unset is "local".
  readonly runtime?: RuntimeConfig;
  // Where issues live. GitHub by default; "http" speaks Tracker API v1 (docs/tracker-api.md).
  // PRs stay on GitHub either way (src/scm.ts).
  readonly tracker: TrackerConfig;
  // A factory label to the team's own name for it, e.g. LABEL.ready to "ready-for-ai".
  // Applied once, at the tracker boundary; everything inside still speaks LABEL.*.
  readonly labels: Readonly<Record<string, string>>;
}

export type TrackerConfig =
  | { readonly kind: "github" }
  // tokenEnv names the env var holding the bearer token, so the token is never in config.
  // project defaults to config.repo.
  | { readonly kind: "http"; readonly url: string; readonly tokenEnv: string; readonly project?: string };

export interface RuntimeConfig {
  readonly gates?: string;
  readonly check?: string;
}

export type Profile = "solo" | "team" | "startup" | "scaleup" | "enterprise";

// What each profile changes from DEFAULT_CONFIG. "team" is the default's own
// behaviour; the others trade autonomy for review as the company grows.
// solo: auto-approve up to medium risk, auto-merge what merge-policy allows.
// scaleup and enterprise: every plan waits for a human, nothing auto-merges.
export const PROFILES: Readonly<Record<Profile, Partial<Pick<FactoryConfig, "riskPolicy" | "maxOpenFactoryPrs" | "merge">>>> = {
  solo: { riskPolicy: { autoApproveLowRisk: true, autoApproveMaxRisk: "medium" }, maxOpenFactoryPrs: 3, merge: { policy: "auto", autoPaths: [], maxFiles: 10, maxLines: 200 } },
  team: { riskPolicy: { autoApproveLowRisk: true, autoApproveMaxRisk: "low" }, maxOpenFactoryPrs: 5 },
  startup: { riskPolicy: { autoApproveLowRisk: true, autoApproveMaxRisk: "low" }, maxOpenFactoryPrs: 10 },
  scaleup: { riskPolicy: { autoApproveLowRisk: false, autoApproveMaxRisk: "low" }, maxOpenFactoryPrs: 10 },
  enterprise: { riskPolicy: { autoApproveLowRisk: false, autoApproveMaxRisk: "low" }, maxOpenFactoryPrs: 10, merge: { policy: "off", autoPaths: [], maxFiles: 10, maxLines: 200 } },
};

export interface TmuxConfig {
  readonly enabled: boolean;
  readonly session: string;
}

export interface SpendConfig {
  readonly perIssueUsd?: number;
  readonly dailyUsd?: number;
  readonly maxUnreportedRuns?: number;
}

// merge-policy.ts's inputs (plan v2.8.0 item 2). "off" (default) never looks
// at merging; "dry-run" assesses eligibility and posts the audit comment but
// never calls `gh pr merge`; "auto" merges once CI passes and every merge
// gate holds. autoPaths/maxFiles/maxLines replace gate.py's hardcoded
// docs/README-only, 10-file, 200-line allow-list with repo config, since "a
// blog post is often longer than machinist's 200 lines" (plan). A file under
// FactoryConfig.protectedPaths is never eligible, whatever autoPaths says.
export interface MergeConfig {
  readonly policy: "off" | "dry-run" | "auto";
  readonly autoPaths: readonly string[];
  readonly maxFiles: number;
  readonly maxLines: number;
}

// Holdout tests (plan v2.11.0 item C, for "Build a Claude Code Verification
// Harness"): hidden from every agent's worktree by a sparse-checkout
// exclusion (src/git.ts) and refused as a build target by the boundary check
// (src/boundary.ts); verify restores them from the base commit into a
// separate scratch copy and runs `cmd`, rejecting on failure with the test
// name and assertion message only, never the source. Off (the default) when
// `cmd` is empty — the one place that decides on/off, so nothing else
// re-derives it.
export interface HoldoutConfig {
  readonly paths: readonly string[];
  readonly cmd: string;
}

export function holdoutEnabled(holdout: HoldoutConfig): boolean {
  return holdout.cmd !== "";
}

export const DEFAULT_CONFIG: FactoryConfig = {
  repo: "",
  protectedPaths: [],
  postEditCommand: [],
  riskPolicy: { autoApproveLowRisk: true, autoApproveMaxRisk: "low" },
  maxOpenFactoryPrs: 3,
  concurrency: 3,
  pollIntervalSeconds: 15,
  maxBudgetUsd: { triage: 1, plan: 2, build: 5, verify: 3, pr: 1, retro: 0.5 },
  baselineTag: "baseline",
  base: "main",
  stageTimeoutMinutes: 15,
  maxToolCalls: 60,
  gates: [],
  resettable: false,
  setup: [],
  agentCommands: { read: [], build: [], verify: [] },
  agents: { claude: { preset: "claude" } },
  stages: { default: "claude" },
  routes: {},
  spend: {},
  merge: { policy: "off", autoPaths: [], maxFiles: 10, maxLines: 200 },
  holdout: { paths: [], cmd: "" },
  tmux: { enabled: false, session: "factory" },
  prRunSummary: true,
  templateOverrides: [],
  workflow: "feature-to-pr",
  tracker: { kind: "github" },
  labels: {},
};

// The one resolver: DEFAULT_CONFIG, then the profile's defaults, then what the repo set.
export function mergeConfig(partial: Partial<FactoryConfig>): FactoryConfig {
  const p = partial.profile ? PROFILES[partial.profile] : {};
  return {
    ...DEFAULT_CONFIG,
    ...p,
    ...partial,
    riskPolicy: { ...DEFAULT_CONFIG.riskPolicy, ...p.riskPolicy, ...partial.riskPolicy },
    maxBudgetUsd: { ...DEFAULT_CONFIG.maxBudgetUsd, ...partial.maxBudgetUsd },
    agentCommands: { ...DEFAULT_CONFIG.agentCommands, ...partial.agentCommands },
    agents: { ...DEFAULT_CONFIG.agents, ...partial.agents },
    stages: { ...DEFAULT_CONFIG.stages, ...partial.stages },
    routes: { ...DEFAULT_CONFIG.routes, ...partial.routes },
    spend: { ...DEFAULT_CONFIG.spend, ...partial.spend },
    merge: { ...DEFAULT_CONFIG.merge, ...p.merge, ...partial.merge },
    holdout: { ...DEFAULT_CONFIG.holdout, ...partial.holdout },
    tmux: { ...DEFAULT_CONFIG.tmux, ...partial.tmux },
    tracker: partial.tracker ?? DEFAULT_CONFIG.tracker,
    labels: { ...DEFAULT_CONFIG.labels, ...partial.labels },
  };
}

// Every key is listed here; the Record type makes tsc fail if FactoryConfig
// gains a key that is not. `riskCriteria` is never read by the runner (the
// factory-plan skill reads it). A `_`-prefixed key is a comment. Any other
// unknown key is a typo that would silently do nothing, so boot refuses it.
type Kind = "string" | "posInt" | "positive" | "boolean" | "strings" | "object";
const TOP_LEVEL: Record<keyof FactoryConfig | "riskCriteria", Kind> = {
  repo: "string",
  protectedPaths: "strings",
  postEditCommand: "strings",
  riskPolicy: "object",
  maxOpenFactoryPrs: "posInt",
  concurrency: "posInt",
  pollIntervalSeconds: "posInt",
  maxBudgetUsd: "object",
  baselineTag: "string",
  base: "string",
  stageTimeoutMinutes: "posInt",
  maxToolCalls: "posInt",
  gates: "object",
  packages: "object",
  resettable: "boolean",
  setup: "strings",
  agentCommands: "object",
  agents: "object",
  stages: "object",
  routes: "object",
  spend: "object",
  merge: "object",
  holdout: "object",
  tmux: "object",
  prRunSummary: "boolean",
  templateOverrides: "strings",
  workflow: "string",
  profile: "string",
  runtime: "object",
  tracker: "object",
  labels: "object",
  riskCriteria: "object",
};

function kindOk(value: unknown, kind: Kind): boolean {
  switch (kind) {
    case "string": return typeof value === "string" && value.length > 0;
    case "posInt": return Number.isInteger(value) && (value as number) >= 1;
    case "positive": return typeof value === "number" && Number.isFinite(value) && value > 0;
    case "boolean": return typeof value === "boolean";
    case "strings": return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "object": return typeof value === "object" && value !== null;
  }
}

function checkKeys(obj: Record<string, unknown>, allowed: Record<string, Kind>, where: string, problems: string[]): void {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("_")) continue;
    const kind = allowed[key];
    if (!kind) problems.push(`${where}${key}: unknown key (allowed: ${Object.keys(allowed).join(", ")})`);
    else if (!kindOk(value, kind)) problems.push(`${where}${key}: expected ${kind}, got ${JSON.stringify(value)}`);
  }
}

// Returns every problem at once, so one boot shows the whole list.
export function configProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["config must be a JSON object"];
  const cfg = raw as Record<string, unknown>;
  const problems: string[] = [];
  checkKeys(cfg, TOP_LEVEL, "", problems);
  const nested = (key: string, shape: Record<string, Kind>) => {
    const v = cfg[key];
    if (v !== undefined && kindOk(v, "object") && !Array.isArray(v)) checkKeys(v as Record<string, unknown>, shape, `${key}.`, problems);
  };
  nested("riskPolicy", { autoApproveLowRisk: "boolean", autoApproveMaxRisk: "string" });
  const maxRisk = (cfg.riskPolicy as Record<string, unknown> | undefined)?.autoApproveMaxRisk;
  if (maxRisk !== undefined && maxRisk !== "low" && maxRisk !== "medium") problems.push(`riskPolicy.autoApproveMaxRisk: expected "low" or "medium", got ${JSON.stringify(maxRisk)}`);
  if (cfg.profile !== undefined && !Object.hasOwn(PROFILES, cfg.profile as string)) problems.push(`profile: expected one of ${Object.keys(PROFILES).join(", ")}, got ${JSON.stringify(cfg.profile)}`);
  nested("maxBudgetUsd", { triage: "positive", plan: "positive", build: "positive", verify: "positive", pr: "positive", retro: "positive" });
  nested("spend", { perIssueUsd: "positive", dailyUsd: "positive", maxUnreportedRuns: "posInt" });
  nested("runtime", { gates: "string", check: "string" });
  nested("merge", { policy: "string", autoPaths: "strings", maxFiles: "posInt", maxLines: "posInt" });
  if (cfg.merge !== undefined && kindOk(cfg.merge, "object")) {
    const policy = (cfg.merge as Record<string, unknown>).policy;
    if (policy !== undefined && policy !== "off" && policy !== "dry-run" && policy !== "auto") {
      problems.push(`merge.policy: expected "off", "dry-run" or "auto", got ${JSON.stringify(policy)}`);
    }
  }
  nested("agentCommands", { read: "strings", build: "strings", verify: "strings" });
  nested("tmux", { enabled: "boolean", session: "string" });
  if (cfg.holdout !== undefined && kindOk(cfg.holdout, "object")) {
    const holdout = cfg.holdout as Record<string, unknown>;
    for (const [key, value] of Object.entries(holdout)) {
      if (key.startsWith("_")) continue;
      if (key === "paths") { if (!kindOk(value, "strings")) problems.push(`holdout.paths: expected strings, got ${JSON.stringify(value)}`); }
      // "" is the explicit off switch (holdoutEnabled), so unlike every other
      // "string" key here, empty is allowed: only a non-string is a problem.
      else if (key === "cmd") { if (typeof value !== "string") problems.push(`holdout.cmd: expected string, got ${JSON.stringify(value)}`); }
      else problems.push(`holdout.${key}: unknown key (allowed: paths, cmd)`);
    }
  }
  if (cfg.gates !== undefined) gateProblems(cfg.gates, "gates", problems);
  if (cfg.packages !== undefined) {
    if (!Array.isArray(cfg.packages)) problems.push("packages: expected a list");
    else cfg.packages.forEach((p, i) => {
      const where = `packages[${i}]`;
      if (typeof p !== "object" || p === null) return problems.push(`${where}: expected an object`);
      const pkg = p as Record<string, unknown>;
      checkKeys(pkg, { path: "string", gates: "object", always: "boolean" }, `${where}.`, problems);
      if (typeof pkg.path !== "string" || !pkg.path) problems.push(`${where}.path: required`);
      else if (pkg.path.startsWith("/") || pkg.path.split("/").includes("..")) problems.push(`${where}.path: must be relative to the repo root, got ${JSON.stringify(pkg.path)}`);
      if (pkg.gates === undefined) problems.push(`${where}.gates: required`);
      else gateProblems(pkg.gates, `${where}.gates`, problems);
    });
  }
  problems.push(...agentProblems(cfg.agents, cfg.stages, cfg.routes));
  if (cfg.tracker !== undefined) problems.push(...trackerProblems(cfg.tracker));
  if (cfg.labels !== undefined) problems.push(...labelMapProblems(cfg.labels));
  return problems;
}

function trackerProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["tracker: expected an object"];
  const t = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (t.kind === "github") checkKeys(t, { kind: "string" }, "tracker.", problems);
  else if (t.kind === "http") {
    checkKeys(t, { kind: "string", url: "string", tokenEnv: "string", project: "string" }, "tracker.", problems);
    if (typeof t.url !== "string") problems.push("tracker.url: required");
    // The bearer token goes to this URL, so plain http only to loopback.
    else if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(t.url)) problems.push(`tracker.url: https (plain http only to localhost), got ${JSON.stringify(t.url)}`);
    if (typeof t.tokenEnv !== "string") problems.push("tracker.tokenEnv: required (the name of the env var holding the token)");
    else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.tokenEnv)) problems.push(`tracker.tokenEnv: expected an env var name, got ${JSON.stringify(t.tokenEnv)}`);
  } else problems.push(`tracker.kind: expected "github" or "http", got ${JSON.stringify(t.kind)}`);
  return problems;
}

// The map is inverted on the way back in, so two factory labels may not share a
// team name, and a team name may not be a factory label that keeps its own name.
function labelMapProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["labels: expected an object"];
  const problems: string[] = [];
  const entries = Object.entries(raw as Record<string, unknown>).filter(([k]) => !k.startsWith("_"));
  const seen = new Map<string, string>();
  const unmapped = new Set<string>(Object.values(LABEL).filter((l) => !entries.some(([k]) => k === l)));
  for (const [from, to] of entries) {
    if (typeof to !== "string" || to.trim() === "") { problems.push(`labels.${from}: expected a label name, got ${JSON.stringify(to)}`); continue; }
    if (seen.has(to)) problems.push(`labels.${from}: "${to}" is already the name for ${seen.get(to)}`);
    else if (unmapped.has(to) || (to !== from && entries.some(([k]) => k === to))) problems.push(`labels.${from}: "${to}" is itself a factory label name`);
    seen.set(to, from);
  }
  return problems;
}

function gateProblems(list: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(list)) return void problems.push(`${where}: expected a list`);
  list.forEach((g, i) => {
    if (typeof g !== "object" || g === null) return problems.push(`${where}[${i}]: expected an object`);
    const gate = g as Record<string, unknown>;
    checkKeys(gate, { name: "string", cmd: "string", required: "boolean", role: "string" }, `${where}[${i}].`, problems);
    if (typeof gate.role === "string" && !(GATE_ROLES as readonly string[]).includes(gate.role)) problems.push(`${where}[${i}].role: "${gate.role}" is not one of ${GATE_ROLES.join(", ")}`);
  });
}

const STAGE_KEYS = ["default", "triage", "plan", "build", "verify", "pr", "retro"];
// Triage runs before an issue's type is known, so a route can never override it.
const ROUTABLE_STAGE_KEYS = STAGE_KEYS.filter((s) => s !== "triage" && s !== "default");

// An agent is a preset or a command. `{{prompt}}` in the executable slot would
// run the prompt as a program (assembler validateConfig), so it is refused.
function agentProblems(agents: unknown, stages: unknown, routes?: unknown): string[] {
  const problems: string[] = [];
  const named = new Set(["claude"]);
  if (agents !== undefined && typeof agents === "object" && agents !== null && !Array.isArray(agents)) {
    for (const [name, raw] of Object.entries(agents as Record<string, unknown>)) {
      if (name.startsWith("_")) continue;
      named.add(name);
      const where = `agents.${name}.`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        problems.push(`agents.${name}: expected an object`);
        continue;
      }
      const a = raw as Record<string, unknown>;
      checkKeys(a, { preset: "string", command: "strings", model: "string", outputSchema: "boolean" }, where, problems);
      if (typeof a.preset === "string" && !PRESETS[a.preset]) problems.push(`${where}preset: unknown "${a.preset}" (built in: ${Object.keys(PRESETS).join(", ")})`);
      if (a.preset === undefined && a.command === undefined) problems.push(`${where}needs a "preset" or a "command"`);
      if (Array.isArray(a.command)) {
        if (a.command.length === 0) problems.push(`${where}command: must not be empty`);
        else if (!String(a.command[0]).trim()) problems.push(`${where}command: the executable must not be empty`);
        else if (/\{\{/.test(String(a.command[0]))) problems.push(`${where}command: the executable cannot be a placeholder`);
        // `sh -c "{{prompt}}"` would run issue text as shell code.
        else if (/^(ba|z|da|k|c)?sh$/.test(String(a.command[0]).split("/").pop()!) && a.command.slice(1).some((x) => /\{\{prompt\}\}/.test(String(x)))) {
          problems.push(`${where}command: {{prompt}} must not be an argument of a shell (use {{promptFile}} or stdin)`);
        }
      }
    }
  } else if (agents !== undefined) problems.push("agents: expected an object");
  if (stages !== undefined && typeof stages === "object" && stages !== null && !Array.isArray(stages)) {
    for (const [stage, agent] of Object.entries(stages as Record<string, unknown>)) {
      if (stage.startsWith("_")) continue;
      if (!STAGE_KEYS.includes(stage)) problems.push(`stages.${stage}: unknown stage (allowed: ${STAGE_KEYS.join(", ")})`);
      else if (typeof agent !== "string" || !named.has(agent)) problems.push(`stages.${stage}: "${String(agent)}" is not an agent in config.agents`);
    }
  } else if (stages !== undefined) problems.push("stages: expected an object");
  if (routes !== undefined && typeof routes === "object" && routes !== null && !Array.isArray(routes)) {
    for (const [type, raw] of Object.entries(routes as Record<string, unknown>)) {
      if (type.startsWith("_")) continue;
      const where = `routes.${type}.`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        problems.push(`routes.${type}: expected an object`);
        continue;
      }
      const r = raw as Record<string, unknown>;
      checkKeys(r, { stages: "object", skills: "strings", proof: "string", workflow: "string" }, where, problems);
      if (typeof r.workflow === "string" && !/^[\w-]+$/.test(r.workflow)) problems.push(`${where}workflow: expected a workflow name like "docs-to-pr", got ${JSON.stringify(r.workflow)}`);
      if (r.proof !== undefined && r.proof !== "test" && r.proof !== "check") problems.push(`${where}proof: expected "test" or "check", got ${JSON.stringify(r.proof)}`);
      if (r.stages !== undefined) {
        if (typeof r.stages !== "object" || r.stages === null || Array.isArray(r.stages)) problems.push(`${where}stages: expected an object`);
        else {
          for (const [stage, agent] of Object.entries(r.stages as Record<string, unknown>)) {
            if (stage.startsWith("_")) continue;
            if (!ROUTABLE_STAGE_KEYS.includes(stage)) problems.push(`${where}stages.${stage}: unknown stage (allowed: ${ROUTABLE_STAGE_KEYS.join(", ")})`);
            else if (typeof agent !== "string" || !named.has(agent)) problems.push(`${where}stages.${stage}: "${String(agent)}" is not an agent in config.agents`);
          }
        }
      }
    }
  } else if (routes !== undefined) problems.push("routes: expected an object");
  return problems;
}

export class ConfigError extends Error {}

export async function loadConfig(targetRepoDir: string): Promise<FactoryConfig> {
  const path = `${targetRepoDir}/.factory/config.json`;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`${path} not found: run \`factory install ${targetRepoDir}\`, then copy config.example.json to config.json and fill it in`);
  }
  const raw = await file.json();
  const problems = configProblems(raw);
  if (problems.length > 0) throw new ConfigError(`${path} is invalid:\n  - ${problems.join("\n  - ")}`);
  let config = mergeConfig(raw as Partial<FactoryConfig>);
  // GitHub calls follow config.repo but git pushes follow origin; a copied config must not aim one at the wrong repo.
  const origin = originRepo(targetRepoDir);
  if (config.repo === "" && origin) config = { ...config, repo: origin };
  // "main" is only a fallback default (DEFAULT_CONFIG.base), never a guess:
  // a config that omits "base" gets whatever origin/HEAD resolves to (a repo
  // on "trunk" or "develop" must not be force-pushed at "main" by default).
  // A config that names "base" explicitly, even "main", is never overridden.
  if ((raw as Record<string, unknown>).base === undefined) {
    const detected = defaultBranchOf(targetRepoDir);
    if (detected) config = { ...config, base: detected };
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.repo)) {
    throw new ConfigError(`${path}: "repo" must be "owner/name", got ${JSON.stringify(config.repo)}`);
  }
  if (origin && origin.toLowerCase() !== config.repo.toLowerCase()) {
    throw new ConfigError(`${path}: "repo" is ${config.repo} but this clone's origin is ${origin}; fix "repo" or remove it to use the origin`);
  }
  // configProblems is pure and cannot see the worktree, so a route naming a
  // skill that was never installed would otherwise only surface as a silent
  // no-op in buildContextPack, mid-run (plan v2.7.0 item 3).
  const missing: string[] = [];
  for (const [type, route] of Object.entries(config.routes)) {
    for (const name of route.skills ?? []) {
      if (!existsSync(`${targetRepoDir}/.claude/skills/${name}/SKILL.md`)) missing.push(`routes.${type}.skills: "${name}" (.claude/skills/${name}/SKILL.md not found)`);
    }
  }
  if (missing.length > 0) throw new ConfigError(`${path} names a skill that does not exist:\n  - ${missing.join("\n  - ")}`);
  return config;
}

// owner/name from an https or ssh remote URL on the GitHub host (github.com, or
// GH_HOST's Enterprise server); anything else (a file path, another host) is not ours to judge.
export function repoFromRemoteUrl(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const host = githubHost(env).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = url.trim().match(new RegExp(`^(?:https?://(?:[^@/]+@)?${host}/|git@${host}:|ssh://git@${host}/)([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// Only a directory that is itself a git checkout counts, so a temp dir under some other repo does not inherit its origin.
function originRepo(dir: string): string | undefined {
  if (!existsSync(`${dir}/.git`)) return undefined;
  const r = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? repoFromRemoteUrl(r.stdout.toString()) : undefined;
}

// The branch name behind origin/HEAD, e.g. "trunk" for a repo cloned with a
// non-"main" default. Mirrors ensureRepoClone's origin/HEAD resolution
// (src/repo.ts) for local `--repo-dir` mode, which never runs that clone
// path. Missing on a bare or freshly-inited repo (no remote fetch yet) --
// callers fall back to DEFAULT_CONFIG.base ("main") in that case.
function defaultBranchOf(dir: string): string | undefined {
  if (!existsSync(`${dir}/.git`)) return undefined;
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--abbrev-ref", "origin/HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return undefined;
  const ref = r.stdout.toString().trim();
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : undefined;
}
