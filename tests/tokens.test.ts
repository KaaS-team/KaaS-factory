// Structural: the cockpit's colour is kaas.team's, and asserted, not eyeballed. Every pair the
// page renders reaches its WCAG level, every colour token is in a pair, no other file in
// dashboard/public holds a colour literal, and every var(--x) the page uses is defined.
// Where a kaas.team checkout sits beside a parent directory, tokens.css's declarations and the font must match it.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { COLOR_LITERAL, DECORATIVE, LEVELS, PAIRS, TOKENS_CSS, loadTokens, ratio } from "../dashboard/tokens";

const tokens = loadTokens();
const PUBLIC = join(import.meta.dir, "..", "dashboard", "public");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const rootBlock = (css: string) => /^:root\s*\{[^}]*\}/m.exec(css)?.[0] ?? "";
// The declarations in order, whatever the formatter did to the layout: kaas.team runs Prettier, we do not.
const declarations = (block: string) =>
  block
    .replace(/^:root\s*\{|\}$/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((d) =>
      d
        .replace(/\s+/g, " ")
        .replace(/\s*([:,])\s*/g, "$1")
        .replace(/(^|[^\d.])\.(\d)/g, (_, pre, digit) => `${pre}0.${digit}`)
        .replace(/"/g, "'")
        .trim(),
    )
    .filter(Boolean);

// KAAS_TEAM_DIR, else kaas.team (or kaaslabs/kaas.team) beside this repo or any parent of it.
function kaasTeam(): string | null {
  const found = (d?: string) => !!d && existsSync(join(d, "src/styles/base.css"));
  if (found(process.env.KAAS_TEAM_DIR)) return process.env.KAAS_TEAM_DIR!;
  for (let dir = join(import.meta.dir, ".."); dir !== dirname(dir); dir = dirname(dir)) {
    for (const d of [join(dirname(dir), "kaas.team"), join(dirname(dir), "kaaslabs", "kaas.team")])
      if (found(d)) return d;
  }
  return null;
}
const kaas = kaasTeam();

describe("design tokens", () => {
  test("every pair reaches its level, and every colour token is in a pair", () => {
    const low = PAIRS.filter(([fg, bg, level]) => ratio(tokens[fg]!, tokens[bg]!) < LEVELS[level]).map(
      ([fg, bg, level]) => `${fg} on ${bg} is ${ratio(tokens[fg]!, tokens[bg]!).toFixed(2)}:1, needs ${level}`,
    );
    expect(low).toEqual([]);
    const paired = new Set(PAIRS.flat());
    expect(Object.keys(tokens).filter((t) => !DECORATIVE.includes(t) && !paired.has(t))).toEqual([]);
  });

  test("the kaas brand colours are the ones in the token block", () => {
    for (const t of [
      "--page:#f7f7f7",
      "--surface:#fff",
      "--ink:#171717",
      "--muted:#5c5c5c",
      "--line:#e5e5e5",
      "--wait:#f8d749",
      "--fail:#b4233a",
      "--pass:#1f7a45",
    ])
      expect(rootBlock(readFileSync(TOKENS_CSS, "utf8"))).toContain(t);
  });

  test.skipIf(!kaas)("tokens.css :root block declares what kaas.team base.css declares, in order", () => {
    const theirs = declarations(rootBlock(readFileSync(join(kaas!, "src/styles/base.css"), "utf8")));
    expect(theirs.length).toBeGreaterThan(10);
    expect(declarations(rootBlock(readFileSync(TOKENS_CSS, "utf8")))).toEqual(theirs);
  });

  test.skipIf(!kaas)("Geist is byte-identical to kaas.team's", () => {
    expect(Bun.hash(readFileSync(join(PUBLIC, "fonts", "geist.woff2")))).toBe(
      Bun.hash(readFileSync(join(kaas!, "public/fonts/geist.woff2"))),
    );
  });

  test("no colour literal outside tokens.css", () => {
    const hits = walk(PUBLIC)
      .filter((f) => f !== TOKENS_CSS && /\.(css|js|html)$/.test(f))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) => (COLOR_LITERAL.test(line) ? [`${relative(PUBLIC, f)}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(hits).toEqual([]);
  });

  test("the app manifest and icon use only token colours", () => {
    const tokens = new Set(
      [...readFileSync(TOKENS_CSS, "utf8").matchAll(/--[\w-]+:(#[0-9a-f]{3,8})\b/gi)].map((m) => m[1]),
    );
    for (const f of ["manifest.webmanifest", "icon.svg"]) {
      const used = [...readFileSync(join(PUBLIC, f), "utf8").matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]);
      expect(used.length, f).toBeGreaterThan(0);
      for (const c of used) expect(tokens, `${f} ${c}`).toContain(c);
    }
  });

  test("every var(--x) the page uses is a defined token", () => {
    const defined = new Set([...readFileSync(TOKENS_CSS, "utf8").matchAll(/--([\w-]+):/g)].map((m) => m[1]));
    const used = walk(PUBLIC)
      .filter((f) => /\.(css|js)$/.test(f))
      .flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/var\(--([\w-]+)/g)]
          .map((m) => `${relative(PUBLIC, f)}: --${m[1]}`)
          .filter((u) => !defined.has(u.split("--").pop())),
      );
    expect(used).toEqual([]);
  });
});
