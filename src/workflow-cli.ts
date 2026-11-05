// `factory workflow`: the repo's workflows and the bundled catalog, kept out of cli.ts.

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { EXIT, UsageError, successJson } from "./cli-output";
import type { CliContext } from "./harness-cli";
import { addFromCatalog, catalog, formatCatalog } from "./workflow-catalog";

const USAGE = "usage: factory workflow (list [--catalog] | add <name>) [--repo-dir <path>] [--json]";

export async function cmdWorkflow(c: CliContext): Promise<void> {
  const sub = c.args[1];
  const dir = resolve(c.flag("repo-dir") ?? ".");
  if (sub === "add") {
    const name = c.args[2];
    if (!name || name.startsWith("--")) throw new UsageError(USAGE);
    const out = addFromCatalog(dir, name);
    if (c.has("json")) console.log(successJson(out, "path" in out));
    else if ("path" in out)
      console.log(`factory workflow: wrote ${out.path}; it loads clean. Route a type to it to use it.`);
    else for (const p of out.problems) console.log(`factory workflow: ${p}`);
    if ("problems" in out) process.exit(EXIT.checksFailed);
    return;
  }
  if (sub !== "list") throw new UsageError(USAGE);
  if (c.has("catalog")) {
    const entries = catalog();
    if (c.has("json")) console.log(successJson({ workflows: entries }, true));
    else for (const line of formatCatalog(entries)) console.log(line);
    return;
  }
  const own = join(dir, ".factory", "workflows");
  const names = existsSync(own)
    ? readdirSync(own)
        .filter((f) => /\.(yml|md)$/.test(f))
        .sort()
    : [];
  if (c.has("json")) console.log(successJson({ workflows: names }, true));
  else for (const n of names) console.log(n);
}
