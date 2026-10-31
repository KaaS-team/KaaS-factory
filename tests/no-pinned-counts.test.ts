import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";

// A test that pins the size of a registry branches grow breaks every parallel branch.
const MENTION = /tests\/mutations|tests\/ci-wiring|make\/|loadMutations/;
const PINNED = /\.length\)\.toBe\(\d+\)|toHaveLength\(\d+\)|\.size\)\.toBe\(\d+\)/;
const OPT_OUT = /\/\/ count-ok: \S/;
const NEAR = 3;

// Files outside this change's scope that trip the scan without pinning a registry size. Prefer a
// `// count-ok:` line in the file itself; each entry here needs the reason.
const EXEMPT: Record<string, string> = {
  "mutation-select.test.ts": "counts selectMutations over a fixed in-test list, and the path is only an argument",
};

export interface Finding {
  line: number;
  text: string;
}

// Pinned counts within NEAR lines of a mention of a sharded registry, minus opted-out ones.
export function scan(source: string): { pinned: Finding[]; optOuts: Finding[] } {
  const lines = source.split("\n");
  const mentions = lines.flatMap((l, i) => (MENTION.test(l) ? [i] : []));
  const pinned: Finding[] = [];
  const optOuts: Finding[] = [];
  lines.forEach((text, i) => {
    if (OPT_OUT.test(text)) optOuts.push({ line: i + 1, text: text.trim() });
    if (!PINNED.test(text) || !mentions.some((m) => Math.abs(m - i) <= NEAR)) return;
    if (OPT_OUT.test(lines[i - 1] ?? "")) return;
    pinned.push({ line: i + 1, text: text.trim() });
  });
  return { pinned, optOuts };
}

test("a pinned count near a registry mention is caught", () => {
  for (const pin of ["expect(list.length).toBe(12);", "expect(list).toHaveLength(3);", "expect(seen.size).toBe(4);"]) {
    const src = `const list = loadMutations(root);\n${pin}\n`;
    expect(scan(src).pinned).toHaveLength(1);
  }
});

test("a derived count is not caught", () => {
  const src = "const m = loadMutations(root);\nexpect(m.length).toBe(legacy.length + shards);\n";
  expect(scan(src).pinned).toEqual([]);
});

test("a count far from any mention is not caught", () => {
  const src = `// see tests/mutations\n${"\n".repeat(6)}expect(xs.length).toBe(2);\n`;
  expect(scan(src).pinned).toEqual([]);
});

test("an opt-out with a reason is honoured and listed", () => {
  const src = "const m = loadMutations(root);\n// count-ok: fixture of three\nexpect(m.length).toBe(3);\n";
  const r = scan(src);
  expect(r.pinned).toEqual([]);
  expect(r.optOuts).toHaveLength(1);
});

test("an opt-out without a reason is not honoured", () => {
  const src = "const m = loadMutations(root);\n// count-ok:\nexpect(m.length).toBe(3);\n";
  expect(scan(src).pinned).toHaveLength(1);
});

test("no real test pins the size of a sharded registry", async () => {
  const dir = import.meta.dir;
  const found: string[] = [];
  const optOuts: string[] = [];
  for (const f of readdirSync(dir).filter(
    (n) => n.endsWith(".test.ts") && n !== "no-pinned-counts.test.ts" && !(n in EXEMPT),
  )) {
    const r = scan(await Bun.file(`${dir}/${f}`).text());
    found.push(...r.pinned.map((p) => `tests/${f}:${p.line}: ${p.text}`));
    optOuts.push(...r.optOuts.map((p) => `tests/${f}:${p.line}: ${p.text}`));
  }
  if (optOuts.length) console.log(`count-ok opt-outs:\n${optOuts.join("\n")}`);
  expect(found).toEqual([]);
});
