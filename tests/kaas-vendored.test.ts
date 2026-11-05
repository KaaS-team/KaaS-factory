// scripts/kaas/ is vendored from the shared kit; an edit here is overwritten by the next sync (#623).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drift, hashDir, MANIFEST, writeManifest } from "../scripts/check-kaas-vendored";

const ROOT = join(import.meta.dir, "..");

function kit(): string {
  const root = mkdtempSync(join(tmpdir(), "kaas-vendored-"));
  mkdirSync(join(root, "scripts", "kaas"), { recursive: true });
  writeFileSync(join(root, "scripts", "kaas", "a.py"), "print(1)\n");
  writeFileSync(join(root, "scripts", "kaas", "b.sh"), "echo b\n");
  return root;
}

test("the recorded hashes match the files as they are", () => {
  const recorded = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
  expect(drift(recorded, hashDir(ROOT))).toEqual([]);
});

test("an edited, added or removed file under scripts/kaas is drift", () => {
  const root = kit();
  const recorded = hashDir(root);
  expect(drift(recorded, hashDir(root))).toEqual([]);
  writeFileSync(join(root, "scripts", "kaas", "a.py"), "print(2)\n");
  expect(drift(recorded, hashDir(root)).join("\n")).toContain("scripts/kaas/a.py: differs from the last sync");
  writeFileSync(join(root, "scripts", "kaas", "c.py"), "new\n");
  expect(drift(recorded, hashDir(root)).join("\n")).toContain("scripts/kaas/c.py: not in");
  expect(drift({ ...recorded, "scripts/kaas/gone.py": "x" }, recorded).join("\n")).toContain("gone.py: recorded");
});

test("the sync's --write step records the new hashes, so a synced file is no longer drift", () => {
  const root = kit();
  writeFileSync(join(root, MANIFEST), "{}\n");
  expect(drift(JSON.parse(readFileSync(join(root, MANIFEST), "utf8")), hashDir(root))).not.toEqual([]);
  writeManifest(root);
  expect(drift(JSON.parse(readFileSync(join(root, MANIFEST), "utf8")), hashDir(root))).toEqual([]);
});

test("make check and make fast run the vendored check", () => {
  const mk = readFileSync(join(ROOT, "Makefile"), "utf8");
  expect(mk).toMatch(/^check:.*\bcheck-kaas-vendored\b/m);
  expect(mk).toContain("check-kaas-vendored:\n\tbun scripts/check-kaas-vendored.ts");
  expect(readFileSync(join(ROOT, "make", "fast.mk"), "utf8")).toContain("bun scripts/check-kaas-vendored.ts");
});
