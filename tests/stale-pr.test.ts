// A quiet factory pull request comes back to the inbox as a nudge, which needs `updatedAt` from
// the code host; and iOS gets a PNG touch icon, since it ignores the SVG one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHub } from "../src/github";
import type { GhPr } from "../src/ports/scm";
import { stalePrItems } from "../src/stale-pr";
import { makePlane, owner } from "./remote-plane";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
const pr = (number: number, head: string, daysQuiet: number, extra: Partial<GhPr> = {}): GhPr => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  state: "OPEN",
  headRefName: head,
  isDraft: false,
  closingIssuesReferences: [{ number: number - 100 }],
  updatedAt: new Date(NOW - daysQuiet * DAY).toISOString(),
  ...extra,
});

describe("stale-PR nudge and iOS icon", () => {
  test("a factory PR quiet for 3 days is nudged in the inbox, and iOS gets a 180px PNG touch icon", async () => {
    const prs = [
      pr(112, "factory/issue-12", 4),
      pr(113, "factory/issue-13", 1),
      pr(114, "factory/issue-14", 9, { isDraft: true }),
      pr(115, "factory/learning-2026-10", 9),
      pr(116, "someone/else", 9),
    ];
    const items = stalePrItems(prs, NOW);
    expect(items.map((i) => [i.kind, i.issue])).toEqual([["stale-pr", 12]]);
    expect(items[0]!.ask).toContain("No activity for 4 days");

    const calls: string[][] = [];
    const gh = new GitHub({ run: async (cmd: string[]) => (calls.push(cmd), { code: 0, stdout: "[]", stderr: "" }) });
    await gh.listPrs("acme/widgets");
    expect(calls[0]!.join(" ")).toContain("updatedAt");

    const p = makePlane();
    p.github.prs = [pr(112, "factory/issue-12", 0, { updatedAt: new Date(Date.now() - 4 * DAY).toISOString() })];
    const { items: inbox } = (await (await p.call("GET", "/api/inbox", owner)).json()) as { items: { kind: string }[] };
    expect(inbox.map((i) => i.kind)).toContain("stale-pr");

    // iOS ignores the SVG icon, so the page, the manifest and the offline shell name a 180px PNG.
    const res = await p.call("GET", "/apple-touch-icon.png");
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = new Uint8Array(await res.arrayBuffer());
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const view = new DataView(png.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([180, 180]);
    const pub = (f: string) => readFileSync(join(import.meta.dir, "../dashboard/public", f), "utf8");
    expect(pub("index.html")).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
    expect(pub("manifest.webmanifest")).toContain('"src": "/apple-touch-icon.png", "sizes": "180x180"');
    expect(pub("sw.js")).toContain('"/apple-touch-icon.png"');
  });
});
