// Every model the docs or the example config name must either have a price
// row or be listed as unpriced with a reason, so "Not reported" is a choice.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRICES, UNPRICED } from "../src/pricing";

const root = join(import.meta.dir, "..");
const MODEL = /"model":\s*"([^"]+)"|--model[ =]([A-Za-z0-9._-]+)/g;

function modelsIn(file: string): string[] {
  return [...readFileSync(join(root, file), "utf8").matchAll(MODEL)].map((m) => (m[1] ?? m[2])!);
}

test("every model in the example config and README has a price row or an unpriced reason", () => {
  const models = new Set([...modelsIn("README.md"), ...modelsIn("template/.factory/config.example.json")]);
  expect(models.size).toBeGreaterThan(0);
  for (const m of models) {
    const family = m.replace(/-\d{8}$/, "");
    expect(family in PRICES || m in UNPRICED, `${m}: add a row to PRICES or an entry to UNPRICED`).toBe(true);
  }
});

test("a model is never both priced and unpriced, and every row is dated and sourced", () => {
  for (const m of Object.keys(UNPRICED)) expect(PRICES[m], m).toBeUndefined();
  for (const [m, p] of Object.entries(PRICES)) {
    expect(p.source, m).toMatch(/^https:\/\//);
    expect(p.asOf, m).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});
