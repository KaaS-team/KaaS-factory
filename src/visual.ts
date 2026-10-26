// UI changes get three checks before they can merge: a preview URL, a smoke request that answers,
// and a visual diff against the baseline screenshots, where any changed shot nobody approved is an
// unreviewed diff. Screenshots compare by hash: equal bytes, no diff; anything else, a person looks.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const UI_GLOBS: readonly RegExp[] = [
  /\.(tsx|jsx|vue|svelte|astro|css|scss|html)$/,
  /(^|\/)(public|static|app|pages|components|dashboard\/public)\//,
];

export const isUiChange = (paths: readonly string[], globs = UI_GLOBS) =>
  paths.some((p) => globs.some((re) => re.test(p)));

export const previewUrl = (template: string, pr: number) => template.replaceAll("{pr}", String(pr));

export async function smoke(url: string, timeoutMs = 10_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return res.ok;
  } catch {
    return false;
  }
}

const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

// Shots in `current` that are new or differ from `baseline`, minus those listed as approved.
export function visualDiffs(baseline: string, current: string, approved: readonly string[] = []): string[] {
  if (!existsSync(current)) return [];
  return readdirSync(current)
    .filter((f) => f.endsWith(".png"))
    .filter((f) => !existsSync(join(baseline, f)) || hash(join(baseline, f)) !== hash(join(current, f)))
    .filter((f) => !approved.includes(f));
}

export interface UiFacts {
  readonly changed: boolean;
  readonly preview: boolean;
  readonly smoke: boolean;
  readonly unreviewedDiffs: number;
}

export async function uiFacts(
  paths: readonly string[],
  o: { previewTemplate?: string; pr: number; baseline: string; current: string; approved?: readonly string[] },
): Promise<UiFacts> {
  if (!isUiChange(paths)) return { changed: false, preview: false, smoke: false, unreviewedDiffs: 0 };
  const url = o.previewTemplate ? previewUrl(o.previewTemplate, o.pr) : undefined;
  return {
    changed: true,
    preview: url !== undefined,
    smoke: url !== undefined && (await smoke(url)),
    unreviewedDiffs: visualDiffs(o.baseline, o.current, o.approved).length,
  };
}
