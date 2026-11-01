// Every file under src/mc/ reaches the network, the log and the environment through its one module.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "src", "mc");

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function violations(file: string, src: string): string[] {
  const text = strip(src);
  const out: string[] = [];
  if (file !== "safe-fetch.ts" && /\bfetch\(/.test(text)) out.push("bare fetch(: use safeFetch");
  if (file !== "log.ts" && /\bconsole\./.test(text)) out.push("console.: use src/mc/log.ts");
  if (file !== "connections.ts" && /\bprocess\.env\s*(\[|\.)/.test(text))
    out.push("process.env: only src/mc/connections.ts reads the environment");
  for (const t of text.match(/`[^`]*`/g) ?? [])
    if (/\$\{[^}]*(token|key|secret)[^}]*\}/i.test(t) && /:\/\/|\?|&/.test(t))
      out.push(`a key in a URL template: ${t.slice(0, 60)}`);
  return out;
}

describe("src/mc structure", () => {
  const files = readdirSync(ROOT).filter((f) => f.endsWith(".ts"));
  test("there are files to hold", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) test(f, () => expect(violations(f, readFileSync(join(ROOT, f), "utf8"))).toEqual([]));
});

describe("the detector bites", () => {
  test("bare fetch", () => expect(violations("a.ts", "await fetch(u)").length).toBe(1));
  test("safe-fetch may fetch", () => expect(violations("safe-fetch.ts", "deps.fetch(u)")).toEqual([]));
  test("safeFetch is not a bare fetch", () => expect(violations("a.ts", "await safeFetch(u)")).toEqual([]));
  test("console", () => expect(violations("a.ts", "console.log(1)").length).toBe(1));
  test("process.env", () => {
    expect(violations("a.ts", "process.env.X").length).toBe(1);
    expect(violations("a.ts", 'process.env["X"]').length).toBe(1);
    expect(violations("connections.ts", "process.env.X")).toEqual([]);
  });
  test("a key in a URL", () => {
    expect(violations("a.ts", "const u = `https://x.test/a?k=${apiKey}`;").length).toBe(1);
    expect(violations("a.ts", "const u = `https://x.test/a/${id}`;")).toEqual([]);
  });
  test("comments are ignored", () => expect(violations("a.ts", "// fetch(x) console.log\n")).toEqual([]));
});
