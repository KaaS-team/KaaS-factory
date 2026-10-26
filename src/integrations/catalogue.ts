// The connectors catalogue: one integrations/<name>/manifest.json per thing the factory plugs into,
// read here and nowhere else. docs/integrations.md's table is generated from it, and
// tests/integrations.test.ts fails when a manifest, its module, its contract test or the doc disagree.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KINDS = ["tracker", "runtime", "agent", "notifier", "intake"] as const;
export type IntegrationKind = (typeof KINDS)[number];

export interface Manifest {
  readonly name: string;
  readonly kind: IntegrationKind;
  readonly summary: string;
  // The env var names it reads. Values never go in a manifest.
  readonly env: readonly string[];
  // How a user turns it on, as one line of config or env.
  readonly enable: string;
  readonly module: string;
  readonly contract: string;
  // Off unless a user turns it on (A2A, AG-UI).
  readonly default: boolean;
  // The name config uses for it, when that differs from the folder (`http` for http-sandbox).
  readonly configKind?: string;
  // A suite against the vendor's real service, skipped with a reason while these keys are unset.
  readonly live?: { readonly test: string; readonly env: readonly string[] };
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ROOT = join(import.meta.dir, "..", "..");

export function manifestProblems(m: Partial<Manifest>, dir: string, exists: (p: string) => boolean): string[] {
  const at = `integrations/${dir}/manifest.json`;
  const out: string[] = [];
  if (m.name !== dir) out.push(`${at}: name must be "${dir}"`);
  if (!KINDS.includes(m.kind as IntegrationKind)) out.push(`${at}: kind must be one of ${KINDS.join(", ")}`);
  if (!m.summary) out.push(`${at}: summary is empty`);
  if (!m.enable) out.push(`${at}: enable is empty`);
  if (typeof m.default !== "boolean") out.push(`${at}: default must be true or false`);
  for (const k of [...(m.env ?? []), ...(m.live?.env ?? [])])
    if (!ENV_NAME.test(k)) out.push(`${at}: ${JSON.stringify(k)} is not an env var name`);
  if (!Array.isArray(m.env)) out.push(`${at}: env must list the env var names it reads`);
  for (const [field, path] of [
    ["module", m.module],
    ["contract", m.contract],
    ["live.test", m.live?.test],
  ] as const)
    if (field === "live.test" ? path !== undefined && !exists(path) : !path || !exists(path))
      out.push(`${at}: ${field} ${path ?? "(missing)"} does not exist`);
  return out;
}

export function loadManifests(root = ROOT): Manifest[] {
  const dir = join(root, "integrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const m = JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8")) as Manifest;
      const problems = manifestProblems(m, name, (p) => existsSync(join(root, p)));
      if (problems.length) throw new Error(problems.join("\n"));
      return m;
    });
}

export const TABLE_START = "<!-- integrations-table:start -->";
export const TABLE_END = "<!-- integrations-table:end -->";

const code = (xs: readonly string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "none");

export function integrationsTable(manifests: readonly Manifest[]): string {
  const rows = [...manifests]
    .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name))
    .map((m) =>
      [
        `\`${m.name}\``,
        m.kind,
        m.summary,
        m.enable,
        code(m.env),
        m.default ? "yes" : "no",
        m.live ? code(m.live.env) : "n/a",
      ].join(" | "),
    );
  return [
    "Integration | Kind | What it does | Turn it on | Env keys | On by default | Live test keys",
    "--- | --- | --- | --- | --- | --- | ---",
    ...rows,
  ]
    .map((l) => `| ${l} |`)
    .join("\n");
}

export function renderIntegrationsDoc(doc: string, manifests: readonly Manifest[]): string {
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) throw new Error("docs/integrations.md has no integrations-table markers");
  return `${doc.slice(0, start + TABLE_START.length)}\n${integrationsTable(manifests)}\n${doc.slice(end)}`;
}
