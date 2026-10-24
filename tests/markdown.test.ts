// The cockpit draws the factory's own GitHub comments as markdown. A real triage and
// plan pair renders headings, lists and code, and no raw markdown is left as text.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inline, markdownText, parseMarkdown } from "../dashboard/public/lib/markdown.js";

type Node = string | { t: string; a: Record<string, unknown>; c: Node[] };
const plan = readFileSync(join(import.meta.dir, "fixtures/comments/triage-and-plan.md"), "utf8");

const walk = (nodes: Node[]): Exclude<Node, string>[] =>
  nodes.flatMap((n) => (typeof n === "string" ? [] : [n, ...walk(n.c)]));
const text = (nodes: Node[]): string => nodes.map((n) => (typeof n === "string" ? n : text(n.c))).join("");
// Code spans keep their characters on purpose (`src/money/**`), so prose is checked without them.
const prose = (nodes: Node[]): string =>
  nodes.map((n) => (typeof n === "string" ? n : n.t === "code" ? "" : prose(n.c))).join("");
const tags = (nodes: Node[]) => walk(nodes).map((n) => n.t);

describe("the factory's triage and plan comment", () => {
  const tree = parseMarkdown(plan) as Node[];

  test("headings, lists, bold and code become elements", () => {
    const heads = walk(tree)
      .filter((n) => /^h\d$/.test(n.t))
      .map((n) => `${n.t} ${text(n.c)}`);
    expect(heads).toEqual(
      expect.arrayContaining(["h3 Triage", "h3 Plan (rev 1)", "h4 Acceptance criteria", "h4 Tests to write first"]),
    );
    expect(tags(tree)).toEqual(expect.arrayContaining(["ul", "li", "strong", "code", "br"]));
    const firstCriterion = walk(tree).find((n) => n.t === "li" && text(n.c).startsWith("AC-1"))!;
    expect(firstCriterion.c[0]).toMatchObject({ t: "strong" });
  });

  test("no markdown syntax and no hidden comment is left in the text", () => {
    const all = prose(tree);
    expect(all).not.toMatch(/(^|\n)#+ |\*\*|<!--|factory:data/);
    expect(all).toContain("Disposition: proceed");
  });

  test("the inbox preview reads as prose", () => {
    expect(markdownText(plan).slice(0, 40)).toBe("Triage Disposition: proceed Type: bug Ri");
  });
});

describe("the renderer is safe and small", () => {
  test("only an http(s) link becomes a link", () => {
    expect(walk(inline("[x](javascript:alert(1))") as Node[])).toEqual([]);
    expect(inline("[pr](https://github.com/a/b/pull/1)")[0]).toMatchObject({
      t: "a",
      a: { href: "https://github.com/a/b/pull/1" },
    });
  });

  test("markup in a comment stays text", () => {
    const tree = parseMarkdown("<img src=x onerror=alert(1)> **hi**") as Node[];
    expect(walk(tree).some((n) => n.t === "img")).toBe(false);
    expect(text(tree)).toBe("<img src=x onerror=alert(1)> hi");
  });

  test("snake_case and a lone star stay as written", () => {
    expect(text(inline("auto_approve_low_risk and 2 * 3 * 4") as Node[])).toBe("auto_approve_low_risk and 2 * 3 * 4");
  });

  test("a fenced block, a table and a task list", () => {
    const tree = parseMarkdown(
      "```\n**raw**\n```\n\n| Stage | Cost |\n|---|---|\n| build | $1 |\n\n- [x] done\n- [ ] open\n  - nested",
    ) as Node[];
    const code = walk(tree).find((n) => n.t === "code")!;
    expect(code.c).toEqual(["**raw**"]);
    expect(
      walk(tree)
        .filter((n) => n.t === "td")
        .map((n) => text(n.c)),
    ).toEqual(["build", "$1"]);
    expect(
      walk(tree)
        .filter((n) => n.t === "input")
        .map((n) => n.a.checked),
    ).toEqual([true, false]);
    expect(walk(tree).filter((n) => n.t === "ul")).toHaveLength(2);
  });
});
