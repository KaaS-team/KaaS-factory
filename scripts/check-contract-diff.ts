// Names what a change removes from the API spec and the CLI reference. Additions are not reported.
// Usage: bun scripts/check-contract-diff.ts <base-ref> [--allow-breaking]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const OPENAPI_FILE = "src/api/openapi.json";
export const CLI_FILE = "docs/cli-reference.md";

type Json = { [key: string]: unknown };
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function schemaProps(schema: unknown, prefix: string, out: Set<string>): void {
  if (!isObj(schema)) return;
  if (isObj(schema.properties)) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      out.add(`${prefix}.${name}`);
      schemaProps(sub, `${prefix}.${name}`, out);
    }
  }
  schemaProps(schema.items, `${prefix}[]`, out);
}

function contentProps(holder: unknown, prefix: string, out: Set<string>): void {
  if (!isObj(holder) || !isObj(holder.content)) return;
  for (const [mime, media] of Object.entries(holder.content)) {
    if (isObj(media)) schemaProps(media.schema, `${prefix} ${mime}`, out);
  }
}

/** Sorted `METHOD path` entries plus one `METHOD path status mime.property` entry per schema property. */
export function openapiSurface(json: string): string[] {
  const out = new Set<string>();
  const spec: unknown = JSON.parse(json);
  const paths = isObj(spec) && isObj(spec.paths) ? spec.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!isObj(op)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      out.add(key);
      contentProps(op.requestBody, `${key} request`, out);
      if (isObj(op.responses)) {
        for (const [status, res] of Object.entries(op.responses)) contentProps(res, `${key} ${status}`, out);
      }
    }
  }
  const schemas =
    isObj(spec) && isObj(spec.components) && isObj(spec.components.schemas) ? spec.components.schemas : {};
  for (const [name, schema] of Object.entries(schemas)) schemaProps(schema, name, out);
  return [...out].sort();
}

/** Sorted `command <name>` entries, `<name> --flag` entries from usage lines and `option --flag` entries. */
export function cliSurface(markdown: string): string[] {
  const out = new Set<string>();
  let command = "";
  let inFence = false;
  let inOptions = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      for (const token of line.split(/[\s[\]()|<>,]+/)) {
        if (command && token.startsWith("--") && token.length > 2) out.add(`${command} ${token}`);
      }
      continue;
    }
    if (line.startsWith("### ")) {
      command = line.slice(4).trim();
      out.add(`command ${command}`);
    } else if (line.startsWith("## ")) {
      command = "";
      inOptions = line.trim() === "## Options";
    } else if (inOptions && line.startsWith("- `")) {
      const name = line.slice(3).split("`")[0] ?? "";
      for (const part of name.split(",")) {
        const flag = part.trim().split(" ")[0] ?? "";
        if (flag.startsWith("-")) out.add(`option ${flag}`);
      }
    }
  }
  return [...out].sort();
}

export function removals(base: string[], head: string[]): string[] {
  return base.filter((x) => !head.includes(x));
}

function atBase(ref: string, file: string): string | undefined {
  const r = spawnSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

export function report(ref: string): string[] {
  const pairs: [string, (s: string) => string[]][] = [
    [OPENAPI_FILE, openapiSurface],
    [CLI_FILE, cliSurface],
  ];
  const lines: string[] = [];
  for (const [file, surface] of pairs) {
    const base = atBase(ref, file);
    if (base === undefined || !existsSync(file)) continue;
    for (const gone of removals(surface(base), surface(readFileSync(file, "utf8"))))
      lines.push(`${file}: removed ${gone}`);
  }
  return lines;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allow = args.includes("--allow-breaking");
  const ref = args.find((a) => !a.startsWith("--"));
  if (!ref) {
    console.error("usage: bun scripts/check-contract-diff.ts <base-ref> [--allow-breaking]");
    process.exit(2);
  }
  const lines = report(ref);
  for (const l of lines) console.log(l);
  if (lines.length === 0) process.exit(0);
  if (allow) process.exit(0);
  process.exit(1);
}
