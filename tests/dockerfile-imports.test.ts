import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const copied = [...readFileSync(join(root, "Dockerfile"), "utf8").matchAll(/^COPY (?!--from)(.+) \.\/\S*$/gm)].flatMap(
  (m) => (m[1] ?? "").split(" ").map((p) => p.replace(/\/$/, "")),
);
const roots = ["bin", "src", "contrib", "dashboard", "ee"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === "tests" || n === "fixtures") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(n) ? [p] : [];
  });
}

// The image copies only some directories, so an import that leaves them starts a container that exits.
test("every relative import from a copied directory lands on a path the Dockerfile copies", () => {
  const missing: string[] = [];
  for (const file of roots.flatMap((r) => (existsSync(join(root, r)) ? walk(join(root, r)) : []))) {
    for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = relative(root, resolve(dirname(file), m[1] ?? ""));
      const ok = copied.some((c) => target === c || target.startsWith(`${c}/`) || target === c.replace(/\.ts$/, ""));
      if (!ok) missing.push(`${relative(root, file)} imports ${m[1]}`);
    }
  }
  expect(missing).toEqual([]);
});
