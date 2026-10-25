// Where a repo's workflow comes from: `.factory/workflows/<name>.yml` in its
// clone, else the copy this runner ships in template/. Parsed and checked
// against the step types the engine has, so a bad file fails at load.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type FactoryConfig } from "../config";
import { parseWorkflow, type Workflow, type WorkflowResult } from "../core/workflow";
import { STEP_TYPES } from "./steps";

export const DEFAULT_WORKFLOW = DEFAULT_CONFIG.workflow;
// What an edge's `if:` may read besides the step ids.
export const EXPR_ROOTS = ["toggles", "config"] as const;

export const BUNDLED_DIR = join(import.meta.dir, "..", "..", "template", ".factory", "workflows");

export function parseWorkflowText(text: string): WorkflowResult {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    return { ok: false, problems: [`not valid YAML: ${(e as Error).message}`] };
  }
  return parseWorkflow(raw, STEP_TYPES, EXPR_ROOTS);
}

let bundled: Workflow | undefined;

// The pipeline the factory has always run, from the template it ships.
export function defaultWorkflow(): Workflow {
  if (bundled) return bundled;
  const parsed = parseWorkflowText(readFileSync(join(BUNDLED_DIR, `${DEFAULT_WORKFLOW}.yml`), "utf8"));
  if (!parsed.ok) throw new Error(`the bundled ${DEFAULT_WORKFLOW} workflow is invalid: ${parsed.problems.join("; ")}`);
  bundled = parsed.workflow;
  return bundled;
}

type ReadFile = (path: string) => Promise<string | undefined>;
const readIfThere: ReadFile = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : undefined;
};

// The repo's own file wins over the bundled one of the same name; a missing
// file falls back to it, and a broken one is an error, never a silent default.
// `read` is doctor's file reader, so its checks see what the watcher would.
export async function loadWorkflow(
  cloneDir: string,
  name: string = DEFAULT_WORKFLOW,
  read: ReadFile = readIfThere,
): Promise<WorkflowResult> {
  if (!/^[\w-]+$/.test(name)) return { ok: false, problems: [`workflow "${name}": letters, digits, - and _ only`] };
  for (const dir of [join(cloneDir, ".factory", "workflows"), BUNDLED_DIR]) {
    const text = await read(join(dir, `${name}.yml`));
    if (text !== undefined) return parseWorkflowText(text);
  }
  return { ok: false, problems: [`workflow "${name}": no .factory/workflows/${name}.yml in the repo or the runner`] };
}

// The workflow a watcher runs for this repo; a broken one stops it at boot with every problem.
export async function workflowFor(cloneDir: string, config: Pick<FactoryConfig, "workflow">): Promise<Workflow> {
  const loaded = await loadWorkflow(cloneDir, config.workflow);
  if (!loaded.ok) throw new Error(`workflow ${config.workflow} is invalid:\n  - ${loaded.problems.join("\n  - ")}`);
  return loaded.workflow;
}

// Every workflow a route names (routes.<type>.workflow) other than the repo's, by name. Loaded at
// boot like the repo's, so a typo stops the watcher instead of parking the first issue of that type.
export async function routeWorkflowsFor(
  cloneDir: string,
  config: Pick<FactoryConfig, "workflow" | "routes">,
): Promise<Record<string, Workflow>> {
  const names = new Set(
    Object.entries(config.routes ?? {}).flatMap(([type, r]) =>
      type.startsWith("_") || !r?.workflow || r.workflow === config.workflow ? [] : [r.workflow],
    ),
  );
  const out: Record<string, Workflow> = {};
  for (const name of names) out[name] = await workflowFor(cloneDir, { workflow: name });
  return out;
}
