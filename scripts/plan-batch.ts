// Prints the specs that can launch together: `bun scripts/plan-batch.ts --specs <dir> --prs <prs.json> --limit <n> [--done a,b]`.
// Picked names go to stdout, one per line; skipped specs go to stderr. It launches nothing.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { planBatch, specFiles } from "../src/batch-plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (import.meta.main) {
  const dir = arg("specs");
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory())
    fail(`plan-batch: --specs directory not found: ${dir ?? "(missing)"}`);
  const prsFile = arg("prs");
  if (!prsFile || !existsSync(prsFile)) fail(`plan-batch: --prs file not found: ${prsFile ?? "(missing)"}`);
  const limit = Number(arg("limit") ?? "");
  if (!Number.isInteger(limit) || limit < 1) fail("plan-batch: --limit must be a positive integer");
  const done = (arg("done") ?? "").split(",").filter(Boolean);

  const prs = JSON.parse(readFileSync(prsFile, "utf8")) as { files?: { path: string }[] }[];
  const busy = prs.map((pr) => (pr.files ?? []).map((f) => f.path));
  const specs = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const deps = /^Deps:\s*(.+)$/m
        .exec(text)?.[1]
        ?.split(",")
        .map((d) => d.trim())
        .filter((d) => d && d !== "none");
      return { name: f.replace(/\.md$/, ""), files: specFiles(text), deps };
    });
  const { picked, skipped } = planBatch(specs, busy, limit, done);
  for (const name of picked) console.log(name);
  for (const s of skipped) console.error(`skipped: ${s.name} ${s.reason}`);
}
