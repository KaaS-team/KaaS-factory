// The run page reads what a real run left: the plan's criteria with the verdict's status,
// the gate line, the revert proof, and the agent's stream as cards.

import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveItems, proofView } from "../dashboard/run-page";

const run = join(import.meta.dir, "fixtures/runs/issue-186");
const read = (f: string) => readFileSync(join(run, f), "utf8");
// Built fresh for each use: bun's toMatchObject leaves its matchers in the object it checked.
const fresh = () => proofView({
  planComment: read("plan-comment.md"),
  verdict: JSON.parse(read("verdict.json")),
  gateLine: JSON.parse(read("gate.json")).line,
  proof: JSON.parse(read("proof.json")),
});
const proof = fresh();

describe("the proof panel", () => {
  test("each criterion carries the plan's words and the verdict's status", () => {
    expect(proof.criteria.map((c) => `${c.id} ${c.status}`)).toEqual(["AC-1 pass", "AC-2 pass", "AC-3 pass", "AC-4 pass"]);
    expect(proof.criteria[3]).toMatchObject({ what: "The full gate passes", check: "`make check`" });
    expect(proof.criteria[0]!.what).not.toContain("checked by");
  });

  test("the gate and the revert read as results, not files", () => {
    expect(proof.gate).toEqual({ status: "GREEN", passed: 3, failed: 0, skipped: 1, nonBlocking: ["audit"] });
    expect(proof.revert).toMatchObject({ status: "bites", reverted: ["src/csv.ts"] });
    // The tail is cut, so the summary at its end is the only full list; order is not the point.
    expect(proof.revert!.failedTests).toHaveLength(4);
    expect(proof.revert!.failedTests).toEqual(expect.arrayContaining([
      "exportCsv formats the amount column as a decimal",
      "exportCsv keeps two decimal places",
      "exportCsv formats an amount under one dollar with a leading zero",
      "exportCsv keeps header and row count",
    ]));
    expect(proof.result).toBe("pass");
    expect(proof.findings[0]).toMatchObject({ severity: "could", fix: expect.stringContaining("5 cents") });
  });

  test("a run with nothing yet shows nothing", () => {
    expect(proofView({})).toEqual({ criteria: [], gate: null, revert: null, findings: [], result: null });
  });
});

describe("the live feed", () => {
  const stream = join(import.meta.dir, "fixtures/agents/claude/build.jsonl");

  test("the stream becomes cards, and `from` returns only the new ones", () => {
    const all = liveItems(stream);
    expect(all.items.some((i) => i.kind === "tool" && i.name === "Edit" && i.diff)).toBe(true);
    expect(all.items.some((i) => i.kind === "result" && i.rows.some((r) => r.tone === "fail"))).toBe(true);
    const rest = liveItems(stream, all.next - 2);
    expect(rest.items).toEqual(all.items.slice(-2));
    expect(liveItems(stream, all.next).items).toEqual([]);
  });

  test("a stream that restarted from scratch is read from the top", () => {
    expect(liveItems(stream, 1e6).items.length).toBe(liveItems(stream).next);
    expect(liveItems(join(run, "no-such.jsonl"))).toEqual({ items: [], next: 0 });
  });
});

describe("the page draws the feed as steps", async () => {
  // The browser module imports its sibling by URL path; point that path at the file.
  mock.module("/lib/markdown.js", () => import("../dashboard/public/lib/markdown.js"));
  const { feedCard, proofPanel, toolSentence } = await import("../dashboard/public/lib/run-page.js");
  type El = { t: string; a: Record<string, unknown>; c: (El | string)[] };
  const h = (t: string, a: Record<string, unknown> | null, ...c: unknown[]): El => ({ t, a: a ?? {}, c: (c.flat(9) as (El | string | null | false)[]).filter((k): k is El | string => k != null && k !== false) });
  const text = (n: El | string): string => (typeof n === "string" ? n : n.c.map(text).join(""));
  const tags = (n: El | string): string[] => (typeof n === "string" ? [] : [n.t, ...n.c.flatMap(tags)]);

  test("a tool call reads as a sentence", () => {
    expect(toolSentence("Write", "tests/csv.test.ts")).toBe("Wrote tests/csv.test.ts");
    expect(toolSentence("Bash", "make test")).toBe("Ran make test");
  });

  test("a failing test run says Failed; a file listing stays folded", () => {
    const fail = feedCard({ kind: "result", ok: false, nested: false, rows: [{ text: "1 fail", tone: "fail" }] }, h);
    expect(text(fail)).toStartWith("Failed");
    const listing = feedCard({ kind: "result", ok: true, nested: false, rows: [{ text: "src/csv.ts", tone: "plain" }] }, h);
    expect(listing.t).toBe("details");
  });

  test("the run's own records show no body, a new file shows its first lines", () => {
    const diff = { removed: [], added: Array.from({ length: 20 }, (_, i) => `line ${i}`), removedMore: 0, addedMore: 0 };
    expect(tags(feedCard({ kind: "tool", name: "Write", target: ".factory/runs/issue-1/plan.json", nested: false, diff }, h))).not.toContain("pre");
    const wrote = feedCard({ kind: "tool", name: "Write", target: "tests/csv.test.ts", nested: false, diff }, h);
    expect(text(wrote)).toContain("12 more lines");
  });

  test("the proof panel states the revert in plain words", () => {
    expect(text(proofPanel(fresh(), h))).toContain("The fix was reverted and the new test failed, so the test catches the bug.");
    expect(text(proofPanel(proofView({}), h))).toContain("fills in");
  });
});
