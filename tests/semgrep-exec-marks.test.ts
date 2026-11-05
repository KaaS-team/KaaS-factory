// The semgrep rule js-shell-exec-interpolated (scripts/kaas/semgrep.yml) flags `x.exec(\`...${y}...\`)`, which
// is also how SQL reads. Every such call on the tree is either gone or carries `nosemgrep: js-shell-exec-interpolated`
// with a reason on its line or the line above, so the CI scan of a PR that touches it stays green (#348).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CALL = /\b(?:\w+\.)?exec(?:Sync)?\(\s*`[^`]*\$\{/;
const MARK = "nosemgrep: js-shell-exec-interpolated";

export function unmarked(text: string): number[] {
  const lines = text.split("\n");
  return lines.flatMap((l, i) =>
    CALL.test(l) && !l.includes(MARK) && !(lines[i - 1] ?? "").includes(MARK) ? [i + 1] : [],
  );
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "node_modules" || e.name === "kaas"
        ? []
        : walk(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );

describe("interpolated exec calls", () => {
  test("every one on the tree is marked", () => {
    const bad = ["src", "scripts", "dashboard", "bin"]
      .flatMap((d) => {
        try {
          return walk(d);
        } catch {
          return [];
        }
      })
      .flatMap((f) => unmarked(readFileSync(f, "utf8")).map((n) => `${f}:${n}`));
    expect(bad).toEqual([]);
  });

  test("the scan sees an unmarked call and accepts a marked one", () => {
    expect(unmarked("db.exec(`DROP ${t}`)")).toEqual([1]);
    expect(unmarked(`// ${MARK} -- SQL\ndb.exec(\`DROP \${t}\`)`)).toEqual([]);
    expect(unmarked("db.exec('select 1')")).toEqual([]);
  });
});
