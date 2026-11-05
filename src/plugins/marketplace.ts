// A marketplace is a JSON file listing plugins a person can install. It carries no code, only where
// each plugin comes from. Publishing to one is out of scope.

import { entryProblem, PLUGIN_NAME } from "./manifest";
import { PLUGIN_KINDS, type PluginKind } from "./registry";

export interface MarketplaceEntry {
  readonly name: string;
  readonly kind: PluginKind;
  readonly description: string;
  readonly version: string;
  // An https URL to the plugin's archive.
  readonly source: string;
}

const ENTRY_KEYS = new Set(["name", "kind", "description", "version", "source", "entry"]);

export function marketplaceProblems(raw: unknown, where = "marketplace.json"): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [`${where}: expected an object`];
  const top = raw as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(top)) if (k !== "plugins") out.push(`${where}: ${k}: unknown key`);
  if (!Array.isArray(top.plugins)) return [...out, `${where}: plugins: expected a list`];
  const seen = new Set<string>();
  top.plugins.forEach((p, i) => {
    const at = `${where}: plugins[${i}]`;
    if (typeof p !== "object" || p === null || Array.isArray(p)) return void out.push(`${at}: expected an object`);
    const e = p as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) out.push(`${at}: ${k}: unknown key`);
    if (typeof e.name !== "string" || !PLUGIN_NAME.test(e.name))
      out.push(`${at}: name: expected a lowercase name, got ${JSON.stringify(e.name)}`);
    else if (seen.has(e.name)) out.push(`${at}: name: "${e.name}" is listed twice`);
    else seen.add(e.name);
    if (!PLUGIN_KINDS.includes(e.kind as PluginKind))
      out.push(`${at}: kind: expected one of ${PLUGIN_KINDS.join(", ")}, got ${JSON.stringify(e.kind)}`);
    for (const k of ["description", "version"] as const)
      if (typeof e[k] !== "string" || !e[k]) out.push(`${at}: ${k}: expected a non-empty string`);
    if (typeof e.source !== "string" || !/^https:\/\/[^\s/]+\//.test(e.source))
      out.push(`${at}: source: expected an https URL, got ${JSON.stringify(e.source)}`);
    if (e.entry !== undefined) {
      const p2 = entryProblem(e.entry);
      if (p2) out.push(`${at}: entry: ${p2}`);
    }
  });
  return out;
}
