// Ported from owainlewis/blueprint@54c952b scripts/check_repo.py:58-161 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: only the Markdown checks; the skill-frontmatter check is covered by skills-ref; Python's Path.rglob becomes a directory walk that also skips dist.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const IGNORED_PARTS = new Set([".cache", ".git", "node_modules", "dist", ".worktrees"]);
const LINK_PATTERN = /!?\[[^\]]*\]\(([^)]+)\)/g;
const REFERENCE_USE_PATTERN = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
const REFERENCE_PATTERN = /^ {0,3}\[(?!\^)([^\]]+)\]:[ \t]*(?:<([^>]+)>|(\S+))/gm;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_PATTERN = /(`+)[\s\S]*?\1/g;

export function repositoryFiles(suffix: string, root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (IGNORED_PARTS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(suffix)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function hasUnbalancedFence(text: string): boolean {
  let fence: [string, number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE_PATTERN.exec(line);
    if (!m) continue;
    const marker = m[1]!;
    if (fence === null) {
      fence = [marker[0]!, marker.length];
      continue;
    }
    if (marker[0] === fence[0] && marker.length >= fence[1] && !m[2]!.trim()) fence = null;
  }
  return fence !== null;
}

export function markdownWithoutCode(text: string): string {
  const visible: string[] = [];
  let fence: [string, number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE_PATTERN.exec(line);
    if (fence !== null) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence[1] && !m[2]!.trim()) fence = null;
      visible.push("");
      continue;
    }
    if (m) {
      fence = [m[1]![0]!, m[1]!.length];
      visible.push("");
      continue;
    }
    visible.push(line.startsWith("    ") || line.startsWith("\t") ? "" : line);
  }
  return visible.join("\n").replace(INLINE_CODE_PATTERN, "");
}

export function localTargets(text: string): string[] {
  const visible = markdownWithoutCode(text);
  const targets = [...visible.matchAll(LINK_PATTERN)].map((m) => m[1]!);
  for (const m of visible.matchAll(REFERENCE_PATTERN)) targets.push(m[2] !== undefined ? `<${m[2]}>` : m[3]!);
  return targets;
}

const normalizeLabel = (label: string) => label.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

export function missingReferenceDefinitions(text: string): string[] {
  const visible = markdownWithoutCode(text);
  const defined = new Set([...visible.matchAll(REFERENCE_PATTERN)].map((m) => normalizeLabel(m[1]!)));
  const missing: string[] = [];
  for (const m of visible.matchAll(REFERENCE_USE_PATTERN)) {
    const label = m[2] || m[1]!;
    if (!defined.has(normalizeLabel(label))) missing.push(label);
  }
  return missing;
}

export function linkDestination(raw: string): string {
  const target = raw.trim();
  if (target.startsWith("<")) {
    const closing = target.indexOf(">", 1);
    return closing !== -1 ? target.slice(1, closing) : target.slice(1);
  }
  return target.split(/\s+/)[0]!;
}

export function checkMarkdown(errors: string[], root: string): void {
  for (const path of repositoryFiles(".md", root)) {
    const rel = relative(root, path);
    const text = readFileSync(path, "utf8");
    if (hasUnbalancedFence(text)) errors.push(`Unbalanced fenced code block: ${rel}`);
    for (const label of missingReferenceDefinitions(text))
      errors.push(`Missing reference definition in ${rel}: ${label}`);
    for (const raw of localTargets(text)) {
      const target = linkDestination(raw);
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      let file = target.split("#", 1)[0]!.split("?", 1)[0]!;
      try {
        file = decodeURIComponent(file);
      } catch {}
      if (!file) continue;
      const resolved = file.startsWith("/") ? resolve(root, file.replace(/^\/+/, "")) : resolve(dirname(path), file);
      if (!existsSync(resolved)) errors.push(`Missing local link in ${rel}: ${raw}`);
    }
  }
}
