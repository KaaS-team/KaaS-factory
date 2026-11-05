// Registers every enabled plugin. A plugin lives in <dir>/<name>/ with a plugin.json; the machine
// config says which names are enabled. The shipped agents and step types are always registered by
// the core modules, so an empty list is the default and means the shipped set only.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { factoryHome } from "../paths";
import { parseManifest, type PluginManifest } from "./manifest";
import { agents, steps, trackers } from "./registry";

export const PLUGINS_DIRNAME = "plugins";

export async function loadPlugin(dir: string, expectName?: string): Promise<PluginManifest> {
  const file = join(dir, "plugin.json");
  if (!existsSync(file)) throw new Error(`plugin ${dir}: plugin.json not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: not valid JSON: ${(e as Error).message}`);
  }
  const parsed = parseManifest(raw, file);
  if (!parsed.ok) throw new Error(parsed.problems.join("\n"));
  const { manifest } = parsed;
  if (expectName !== undefined && manifest.name !== expectName)
    throw new Error(`${file}: name: expected "${expectName}" to match its directory, got "${manifest.name}"`);
  const entry = resolve(dir, manifest.entry);
  if (!entry.startsWith(resolve(dir) + sep)) throw new Error(`${file}: entry: must stay inside the plugin directory`);
  if (!existsSync(entry)) throw new Error(`${file}: entry: ${manifest.entry} does not exist`);
  const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  if (mod.default === undefined) throw new Error(`${file}: entry: ${manifest.entry} has no default export`);
  const source = `plugin ${manifest.name} (${file})`;
  if (manifest.kind === "agent") agents.register(manifest.name, mod.default as never, source);
  else if (manifest.kind === "step") steps.register(manifest.name, mod.default as never, source);
  else if (manifest.kind === "extension") {
    if (typeof mod.default !== "function")
      throw new Error(`${file}: entry: an extension plugin default-exports a function`);
    (mod.default as (env: NodeJS.ProcessEnv) => void)(process.env);
  } else {
    if (typeof mod.default !== "function")
      throw new Error(`${file}: entry: a tracker plugin default-exports a function`);
    trackers.register(manifest.name, mod.default as never, source);
  }
  return manifest;
}

const started = new Set<string>();

// Loads the plugins this machine enables that this process has not loaded yet. Idempotent, so every
// entry point may call it.
export async function loadPlugins(root: string, enabled: readonly string[]): Promise<PluginManifest[]> {
  const out: PluginManifest[] = [];
  for (const name of enabled) {
    const key = join(root, name);
    if (started.has(key)) continue;
    out.push(await loadPlugin(key, name));
    started.add(key);
  }
  return out;
}

export function startPlugins(
  machine: { readonly plugins?: { readonly enabled: readonly string[] } },
  env: NodeJS.ProcessEnv = process.env,
) {
  return loadPlugins(join(factoryHome(env), PLUGINS_DIRNAME), machine.plugins?.enabled ?? []);
}
