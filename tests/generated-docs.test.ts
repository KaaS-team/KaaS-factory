// A generated file whose source changes must fail make fast, not only the pre-push hook and CI (#633).
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { affected, GENERATED } from "../scripts/check-generated-docs";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("every generator script has a freshness check in the registry", () => {
  const generators = readdirSync(join(root, "scripts"))
    .filter((f) => /^gen-.*\.ts$/.test(f) || f === "openapi.ts")
    .map((f) => `scripts/${f}`)
    // gen-quality-baseline.ts --check already runs in every make fast.
    .filter((f) => f !== "scripts/gen-quality-baseline.ts");
  expect(generators.filter((g) => !GENERATED.some((e) => e.generator === g))).toEqual([]);
  expect(read("make/fast.mk")).toContain("bun scripts/gen-quality-baseline.ts --check");
});

test("every generated doc is in the registry, and every entry names a real file and generator", () => {
  const marked = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `docs/${f}`)
    .filter((f) => /generated (by|from)|table is generated|do not edit by hand/i.test(read(f)));
  expect(marked.filter((f) => !GENERATED.some((e) => e.file === f))).toEqual([]);
  for (const e of GENERATED) {
    expect(() => read(e.file)).not.toThrow();
    expect(() => read(e.generator)).not.toThrow();
  }
});

test("make fast runs the impact check against BASE", () => {
  expect(read("make/fast.mk")).toContain("bun scripts/check-generated-docs.ts $(BASE)");
});

test("a change to src/help.ts or a file it imports selects make check-cli-reference", () => {
  const imported = readFileSync(join(root, "src/help.ts"), "utf8").match(/from "\.\/([^"]+)"/)?.[1];
  for (const file of ["src/help.ts", ...(imported ? [`src/${imported}.ts`] : [])]) {
    const hit = affected([file], root).find((g) => g.file === "docs/cli-reference.md");
    expect(hit?.check).toEqual(["make", "check-cli-reference"]);
  }
});

test("a change to an unrelated file selects no generated-doc check", () => {
  expect(affected(["README.md"], root)).toEqual([]);
});

test("a change to the generated doc itself, or to the manifests, selects its check", () => {
  expect(affected(["docs/agents.md"], root).map((g) => g.file)).toEqual(["docs/agents.md"]);
  expect(affected(["integrations/x/manifest.json"], root).map((g) => g.file)).toContain("docs/integrations.md");
});
