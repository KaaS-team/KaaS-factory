// A UI change needs a preview, a smoke that answers, and no visual diff nobody reviewed.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factRefusals, type PrFacts } from "../src/pr-facts";
import { uiFacts } from "../src/visual";

test("UI changes get a preview, a smoke test and a visual diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "visual-"));
  const baseline = join(root, "baseline");
  const current = join(root, "current");
  mkdirSync(baseline);
  mkdirSync(current);
  writeFileSync(join(baseline, "home.png"), "same");
  writeFileSync(join(current, "home.png"), "same");
  writeFileSync(join(baseline, "cart.png"), "old");
  writeFileSync(join(current, "cart.png"), "new");
  const server = Bun.serve({
    port: 0,
    fetch: (r) => new Response("ok", { status: new URL(r.url).pathname === "/pr-7" ? 200 : 404 }),
  });
  try {
    const previewTemplate = `http://127.0.0.1:${server.port}/pr-{pr}`;
    const ui = await uiFacts(["web/components/Cart.tsx"], { previewTemplate, pr: 7, baseline, current });
    expect(ui).toEqual({ changed: true, preview: true, smoke: true, unreviewedDiffs: 1 });
    expect((await uiFacts(["web/components/Cart.tsx"], { previewTemplate, pr: 8, baseline, current })).smoke).toBe(
      false,
    );
    expect(
      (
        await uiFacts(["web/components/Cart.tsx"], {
          previewTemplate,
          pr: 7,
          baseline,
          current,
          approved: ["cart.png"],
        })
      ).unreviewedDiffs,
    ).toBe(0);
    expect((await uiFacts(["src/server.ts"], { previewTemplate, pr: 7, baseline, current })).changed).toBe(false);
    const facts = {
      tamper: [],
      risk: { blastRadius: { owners: [], protected: [] }, level: "low" },
      ui,
    } as unknown as PrFacts;
    expect(factRefusals(facts, "semi").map((r) => r.detail)).toContain("8: 1 visual diffs nobody reviewed");
  } finally {
    server.stop(true);
  }
});
