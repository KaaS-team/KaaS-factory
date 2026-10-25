// The cockpit's colour is kaas.team's: public/tokens.css is a line-for-line copy of the :root
// block in kaas.team src/styles/base.css. This reads it back so tests/tokens.test.ts can check
// every pair the page renders reaches its contrast level.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TOKENS_CSS = join(import.meta.dir, "public", "tokens.css");

// --name:#hex pairs from the :root block. Shadows and the tone are not plain colours, so they are skipped.
export function loadTokens(css = readFileSync(TOKENS_CSS, "utf8")): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/--([\w-]+):(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1]!, expand(m[2]!)]));
}

const expand = (hex: string) => (hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex);

// Hairlines, empty bar fills, the waiting fill and the focus ring have nothing written on them.
export const DECORATIVE: readonly string[] = ["line", "rule", "track", "quiet", "wait", "focus"];

export type Level = "AAA" | "AA" | "AA-large";
export const LEVELS: Readonly<Record<Level, number>> = { AAA: 7, AA: 4.5, "AA-large": 3 };

// Every pair the page renders. Status text is small (a failed stage, "Waiting on you"), so it needs AA.
export const PAIRS: ReadonlyArray<readonly [string, string, Level]> = [
  ...["page", "surface", "panel"].flatMap((bg) => [
    ["ink", bg, "AAA"] as const,
    ["muted", bg, "AA"] as const,
    ["faint", bg, "AA"] as const,
    ["pass", bg, "AA"] as const,
    ["fail", bg, "AA"] as const,
    ["wait-ink", bg, "AA"] as const,
  ]),
  ["ink", "wait", "AAA"],
  ["wait-ink", "wait-bg", "AA"],
  ["pass", "pass-bg", "AA"],
  ["fail", "fail-bg", "AA"],
  ["ink", "pass-bg", "AAA"],
  ["ink", "fail-bg", "AAA"],
  ["blue-fg", "blue-bg", "AA"],
  ["purple-fg", "purple-bg", "AA"],
  ["grey-fg", "grey-bg", "AA"],
  ["surface", "ink", "AAA"],
];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// A colour written anywhere but tokens.css is a second palette no pair covers.
export const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/;
