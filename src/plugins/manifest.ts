// A plugin is a directory holding plugin.json. The manifest names it, says which registry it goes
// into and points at the module that default-exports the thing to register. Problems name the field.

import { PLUGIN_KINDS, type PluginKind } from "./registry";

export interface PluginManifest {
  readonly name: string;
  readonly kind: PluginKind;
  // A path inside the plugin directory, to a module whose default export is the agent, step type or tracker factory.
  readonly entry: string;
}

export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEYS = new Set(["name", "kind", "entry", "version", "description"]);

export function entryProblem(entry: unknown): string | undefined {
  if (typeof entry !== "string" || !entry) return "expected a non-empty path";
  if (entry.startsWith("/") || /^[a-z]:/i.test(entry) || entry.split(/[\\/]/).includes(".."))
    return `expected a path inside the plugin directory, got ${JSON.stringify(entry)}`;
  return undefined;
}

export function manifestProblems(raw: unknown, where = "plugin.json"): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${where}: expected an object`];
  const m = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(m)) if (!KEYS.has(k)) out.push(`${where}: ${k}: unknown key`);
  if (typeof m.name !== "string" || !PLUGIN_NAME.test(m.name))
    out.push(`${where}: name: expected a lowercase name (letters, digits, hyphens), got ${JSON.stringify(m.name)}`);
  if (!PLUGIN_KINDS.includes(m.kind as PluginKind))
    out.push(`${where}: kind: expected one of ${PLUGIN_KINDS.join(", ")}, got ${JSON.stringify(m.kind)}`);
  const e = entryProblem(m.entry);
  if (e) out.push(`${where}: entry: ${e}`);
  for (const k of ["version", "description"] as const)
    if (m[k] !== undefined && typeof m[k] !== "string") out.push(`${where}: ${k}: expected a string`);
  return out;
}

export function parseManifest(
  raw: unknown,
  where?: string,
): { ok: true; manifest: PluginManifest } | { ok: false; problems: string[] } {
  const problems = manifestProblems(raw, where);
  if (problems.length) return { ok: false, problems };
  const m = raw as PluginManifest;
  return { ok: true, manifest: { name: m.name, kind: m.kind, entry: m.entry } };
}

// machine.json's `plugins` block: the names to load. A name not in the list is not loaded.
export function pluginsProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["plugins: expected an object"];
  const p = raw as Record<string, unknown>;
  const out = Object.keys(p)
    .filter((k) => k !== "enabled")
    .map((k) => `plugins.${k}: unknown key`);
  if (!Array.isArray(p.enabled)) return [...out, "plugins.enabled: expected a list of plugin names"];
  p.enabled.forEach((n, i) => {
    if (typeof n !== "string" || !PLUGIN_NAME.test(n))
      out.push(`plugins.enabled[${i}]: expected a lowercase plugin name, got ${JSON.stringify(n)}`);
  });
  return out;
}
