// Installs the factory template into a target repo. Default mode never overwrites a file that is
// already there, so a repo customizing a skill keeps its own copy. `update` pulls in runner-side
// fixes: every factory-owned file is overwritten except .claude/settings.json, which a repo may
// have hand-tuned; that one gets a .claude/settings.json.factory-new when it differs. `ci` also
// writes an inert .github/workflows/factory.yml.example. `dryRun` reports without touching anything.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentRegistry } from "./agent-dirs";
import { PRESETS } from "./agents/presets";

export interface InstallOptions {
  dryRun?: boolean;
  update?: boolean;
  ci?: boolean;
  agents?: string[];
}

export interface BundledFiles {
  template: ReadonlyMap<string, Buffer>;
  ci: Buffer | undefined;
}

export interface InstallResult {
  lines: string[];
  wrote: number;
  skipped: string[];
  unchanged: number;
  target: string;
}

// Each agent reads skills from its own dir (a symlink to .claude/skills) and a context file.
// Built from the agent registry, so a preset added there is installable here.
export const AGENT_DIRS: Readonly<Record<string, { skillsDir: string; contextFile: string }>> = Object.fromEntries(
  Object.entries(PRESETS).map(([name, p]) => [
    name,
    { skillsDir: agentRegistry().get(name)?.project ?? p.skillsDir, contextFile: p.contextFile },
  ]),
);

const REPO_OWNED = new Set([".factory/charter.md", ".factory/config.example.json", ".factory/memory/lessons.md"]);
// Files an earlier release installed and this one no longer ships; `update` removes them.
const RETIRED = [".claude/agents/factory-verifier.md", ".claude/agents/factory-explorer.md"];
const CI_DEST_REL = ".github/workflows/factory.yml.example";

const root = resolve(import.meta.dir, "..");

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), rel) : [rel];
  });
}

// template/ and template-ci/ read from the repo root on disk.
export function bundledFiles(): BundledFiles {
  const dir = join(root, "template");
  if (!existsSync(dir)) throw new Error(`no template/ next to the runner (${dir})`);
  const template = new Map(walk(dir).sort().map((rel) => [rel, readFileSync(join(dir, rel))] as const));
  const ciPath = join(root, "template-ci", "factory.yml.example");
  return { template, ci: existsSync(ciPath) ? readFileSync(ciPath) : undefined };
}

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isExecutable = (rel: string): boolean =>
  rel.startsWith(".claude/hooks/") || rel === ".factory/gates.sh" || rel === ".factory/mutate.sh";
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

export function installTemplate(target: string, opts: InstallOptions = {}, files: BundledFiles = bundledFiles()): InstallResult {
  // Validate before anything is written, so a typo never leaves a partial install.
  for (const agent of opts.agents ?? [])
    if (!AGENT_DIRS[agent]) throw new Error(`unknown agent "${agent}" (known: ${Object.keys(AGENT_DIRS).join(", ")})`);
  if (opts.ci && !files.ci) throw new Error("--ci requested but template-ci/factory.yml.example is missing");

  const dry = !!opts.dryRun;
  mkdirSync(target, { recursive: true });
  const base = resolve(target);
  const lines: string[] = [];
  const skipped: string[] = [];
  let wrote = 0;
  let unchanged = 0;
  const owned = new Set<string>();

  for (const [rel, content] of files.template) {
    const dest = join(base, rel);

    // settings.json may carry repo-specific allow/deny entries; update never overwrites it silently.
    if (rel === ".claude/settings.json" && opts.update && lexists(dest)) {
      if (existsSync(dest) && readFileSync(dest).equals(content)) {
        lines.push(`unchanged: ${rel}`);
        unchanged++;
      } else if (dry) {
        lines.push(`differs (would write ${rel}.factory-new for review): ${rel}`);
        wrote++;
      } else {
        writeFileSync(`${dest}.factory-new`, content);
        lines.push(`differs (not overwritten): ${rel}, reconcile with ${rel}.factory-new`);
        wrote++;
      }
      continue;
    }

    // The charter, config example and accumulated lessons are the repo's to edit.
    if (REPO_OWNED.has(rel) && lexists(dest)) {
      lines.push(`skip (repo-owned): ${rel}`);
      skipped.push(rel);
      owned.add(rel);
      continue;
    }

    if (lexists(dest) && !opts.update) { skipped.push(rel); continue; }
    const existed = lexists(dest);
    if (dry) {
      lines.push(`${existed ? "would overwrite" : "write"}: ${rel}`);
      wrote++;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    // Never write through a symlink: replace the link itself.
    if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(dest);
    writeFileSync(dest, content);
    if (isExecutable(rel)) chmodSync(dest, 0o755);
    lines.push(`${existed ? "overwrote" : "wrote"}: ${rel}`);
    wrote++;
  }
  // The skip rule above stays silent; name each file it skipped.
  for (const rel of skipped) if (!owned.has(rel)) lines.push(`skip (exists): ${rel}`);

  if (opts.update)
    for (const rel of RETIRED) {
      if (!lexists(join(base, rel))) continue;
      if (dry) lines.push(`would remove (retired): ${rel}`);
      else {
        rmSync(join(base, rel));
        lines.push(`removed (retired): ${rel}`);
      }
      wrote++;
    }

  // .factory/manifest.json: the sha256 of every factory file that now equals the template, so
  // `factory doctor` can name the ones this repo edits later. Repo-owned files are not listed.
  if (!dry) {
    const entries: string[] = [];
    for (const [rel, content] of files.template) {
      if (REPO_OWNED.has(rel)) continue;
      const dest = join(base, rel);
      if (!existsSync(dest) || !readFileSync(dest).equals(content)) continue;
      entries.push(`    ${JSON.stringify(rel)}: "${sha(content)}"`);
    }
    mkdirSync(join(base, ".factory"), { recursive: true });
    writeFileSync(join(base, ".factory", "manifest.json"), `{\n  "files": {\n${entries.join(",\n")}\n  }\n}\n`);
    lines.push(`wrote: .factory/manifest.json (${entries.length} file(s))`);
  }

  const link = (skillsDir: string, up: string): void => {
    const path = join(base, skillsDir);
    if (lexists(path)) {
      lines.push(`skip (exists): ${skillsDir}`);
      skipped.push(skillsDir);
    } else if (dry) {
      lines.push(`symlink: ${skillsDir} -> ${up}/.claude/skills`);
      wrote++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(`${up}/.claude/skills`, path);
      lines.push(`symlinked: ${skillsDir} -> ${up}/.claude/skills`);
      wrote++;
    }
  };
  link(".agents/skills", "..");

  for (const agent of opts.agents ?? []) {
    const { skillsDir, contextFile } = AGENT_DIRS[agent]!;
    if (skillsDir === ".claude/skills") continue;
    link(skillsDir, dirname(skillsDir).replace(/[^/]+/g, ".."));
    const context = join(base, contextFile);
    if (contextFile !== "CLAUDE.md" && !lexists(context)) {
      if (dry) lines.push(`write: ${contextFile}`);
      else {
        writeFileSync(
          context,
          `# Factory\n\nFactory skills are in .claude/skills/ (linked into ${skillsDir}).\nThe repo charter is .factory/charter.md; read it before any stage.\n`,
        );
        lines.push(`wrote: ${contextFile}`);
      }
      wrote++;
    }
  }

  if (opts.ci) {
    if (dry) lines.push(`write: ${CI_DEST_REL}`);
    else {
      mkdirSync(dirname(join(base, CI_DEST_REL)), { recursive: true });
      writeFileSync(join(base, CI_DEST_REL), files.ci!);
      lines.push(`wrote: ${CI_DEST_REL} (inert, rename to factory.yml and set repo variable FACTORY_MODE=actions to activate)`);
    }
    wrote++;
  }

  lines.push("");
  lines.push(
    `factory install: ${dry ? "would write" : "wrote"} ${wrote} item(s), skipped ${skipped.length} existing item(s), ${unchanged} unchanged in ${base}`,
  );
  if (!existsSync(join(base, ".factory", "config.json")))
    lines.push(
      `factory install: next: cp .factory/config.example.json .factory/config.json, fill in every TODO (config.json, charter.md), then \`factory doctor --fix --repo-dir ${base}\` (creates the factory:* and type labels this repo needs).`,
    );
  return { lines, wrote, skipped, unchanged, target: base };
}
