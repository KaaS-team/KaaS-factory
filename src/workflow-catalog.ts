// The workflows the runner bundles, one line each, and `add`: copy one into the repo's
// .factory/workflows/ after the same parser the watcher uses has accepted it.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkflowMd } from "./core/workflow-md";
import { BUNDLED_DIR, parseWorkflowText } from "./engine/workflows";

export interface CatalogEntry {
  readonly name: string;
  readonly file: string;
  readonly summary: string;
  readonly scheduled: boolean;
}

const firstSentence = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  const end = flat.search(/\.(\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
};

// A .md workflow says what it is in its body; a .yml one in the comment block at the top.
export function summaryOf(text: string): string {
  if (isWorkflowMd(text)) return firstSentence(text.slice(text.indexOf("\n---", 3) + 4));
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("#")) break;
    lines.push(line.replace(/^#\s?/, ""));
  }
  return firstSentence(lines.join(" "));
}

export function catalog(dir: string = BUNDLED_DIR): CatalogEntry[] {
  return readdirSync(dir)
    .filter((f) => /\.(yml|md)$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), "utf8");
      const parsed = parseWorkflowText(text);
      return {
        name: file.replace(/\.(yml|md)$/, ""),
        file,
        summary: summaryOf(text),
        scheduled: parsed.ok && parsed.workflow.triggers.cron.length > 0,
      };
    });
}

export function formatCatalog(entries: readonly CatalogEntry[]): string[] {
  const width = Math.max(...entries.map((e) => e.name.length));
  return entries.map((e) => `${e.name.padEnd(width)}  ${e.scheduled ? "[scheduled] " : ""}${e.summary}`);
}

export function addFromCatalog(
  cloneDir: string,
  name: string,
  dir: string = BUNDLED_DIR,
): { path: string } | { problems: string[] } {
  const entry = /^[\w-]+$/.test(name) ? catalog(dir).find((e) => e.name === name) : undefined;
  if (!entry) return { problems: [`"${name}" is not in the catalog; factory workflow list --catalog shows the names`] };
  const into = join(cloneDir, ".factory", "workflows");
  const taken = [".yml", ".md"].find((ext) => existsSync(join(into, `${name}${ext}`)));
  if (taken) return { problems: [`.factory/workflows/${name}${taken} exists; add never overwrites`] };
  const text = readFileSync(join(dir, entry.file), "utf8");
  const parsed = parseWorkflowText(text);
  if (!parsed.ok) return { problems: parsed.problems.map((p) => `${name}: ${p}`) };
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, entry.file), text);
  return { path: `.factory/workflows/${entry.file}` };
}
