// Two ways a repo's .factory/config.json lets a run down without saying so (#87): a read list too
// empty for plan to inspect dependencies, and an edit the running watcher never reads.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RouteConfig } from "./config";
import type { DoctorCheck } from "./doctor";
import type { WatchDeps } from "./engine/common";
import { refusal, safeCommands } from "./safe-outputs";

// Plan runs under dontAsk, so with no read command a dependency plan's `npm ls` is refused and plan fails.
export function readCommandsCheck(
  routes: Readonly<Record<string, RouteConfig>> | undefined,
  configText: string | undefined,
): DoctorCheck[] {
  const types = Object.entries(routes ?? {})
    .filter(([type, r]) => type === "dependency" || r.workflow === "dependency-update")
    .map(([type]) => type);
  if (types.length === 0) return [];
  let read: string[] = [];
  try {
    read = JSON.parse(configText ?? "{}")?.agentCommands?.read ?? [];
  } catch {
    return [];
  }
  const kept = safeCommands(read);
  const dropped = read.filter((p) => refusal(p) !== undefined);
  return [
    {
      name: "agentCommands.read lets plan inspect dependencies",
      ok: kept.length > 0,
      detail:
        kept.length > 0
          ? `${kept.length} read command(s) for route(s) ${types.join(", ")}`
          : `route(s) ${types.join(", ")} need plan to read installed versions, and agentCommands.read is empty${dropped.length ? ` once refused patterns are dropped (${dropped.join(", ")})` : ""}: add the stack's read commands to .factory/config.json, e.g. "npm ls", "npm ls --all", "git ls-tree *", then restart \`factory watch\``,
      fixable: false,
    },
  ];
}

// The watcher builds its agents, workflows and minions from the config it read at startup, so an
// edit applies only after a restart. Undefined while the file is as the watcher read it.
export function configStaleness(
  path: string,
  mtimeOf: (p: string) => number | undefined = (p) => (existsSync(p) ? statSync(p).mtimeMs : undefined),
): () => string | undefined {
  const loaded = mtimeOf(path);
  return () => {
    const now = mtimeOf(path);
    return loaded !== undefined && now !== undefined && now > loaded
      ? `${path} changed after factory watch started; this run still uses the config read at startup. Restart factory watch to apply the change.`
      : undefined;
  };
}

// Every stage that starts on a stale config logs it and carries it as the first event of its run.
export function warnWhenStale(
  deps: WatchDeps,
  stale = configStaleness(join(deps.cloneDir, ".factory", "config.json")),
): WatchDeps {
  const inner = deps.executor;
  return {
    ...deps,
    executor: {
      async runStage(opts) {
        const warning = stale();
        if (warning) console.warn(`factory watch: ${warning}`);
        const result = await inner.runStage(opts);
        return warning ? { ...result, events: [{ kind: "text", text: warning }, ...result.events] } : result;
      },
    },
  };
}
