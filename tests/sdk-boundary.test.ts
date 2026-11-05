// A package outside the core reaches the core through src/sdk.ts and nothing else, so an internal
// can move without breaking an embedder.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as sdk from "../src/sdk";

const ROOT = resolve(import.meta.dir, "..");
const SDK = join(ROOT, "src", "sdk");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(n) ? [p] : [];
  });
}

const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|export\s+\*\s+from\s+)["']([^"']+)["']/g)].map(
    (m) => m[1] ?? "",
  );

// What a file in `pkg` may not import: a relative path leaving the package for anything but the SDK,
// or a bare path into the core's own directories.
export function boundaryBreaks(file: string, pkg: string, text: string): string[] {
  return specifiers(text).filter((spec) => {
    if (/^(src|dashboard|ee)\//.test(spec)) return true;
    if (!spec.startsWith(".")) return false;
    const target = resolve(dirname(file), spec).replace(/\.(ts|js)$/, "");
    return target !== SDK && target !== pkg && !target.startsWith(`${pkg}/`);
  });
}

export function packageBreaks(root = ROOT): string[] {
  const packages = join(root, "packages");
  return readdirSync(packages).flatMap((name) =>
    statSync(join(packages, name)).isDirectory()
      ? walk(join(packages, name)).flatMap((file) =>
          boundaryBreaks(file, join(packages, name), readFileSync(file, "utf8")).map(
            (s) => `${relative(root, file)} imports ${s}`,
          ),
        )
      : [],
  );
}

describe("sdk boundary", () => {
  test("one module exports the supported surface", () => {
    expect(Object.keys(sdk).sort()).toEqual(["InboxError", "LABEL", "act", "buildInbox", "prItems", "signedBy"]);
  });

  test("no package imports anything from the core but the sdk module", () => {
    expect(packageBreaks()).toEqual([]);
  });

  test("the scan flags a core internal, a bare core path and another package, and passes the sdk and itself", () => {
    const pkg = join(ROOT, "packages", "x");
    const file = join(pkg, "index.ts");
    const breaks = (t: string) => boundaryBreaks(file, pkg, t);
    expect(breaks('import { a } from "../../src/inbox";')).toEqual(["../../src/inbox"]);
    expect(breaks('import("../../src/sdk-extra");')).toEqual(["../../src/sdk-extra"]);
    expect(breaks('import { a } from "src/inbox";')).toEqual(["src/inbox"]);
    expect(breaks('export * from "../protocol/index";')).toEqual(["../protocol/index"]);
    expect(breaks('import { a } from "../../src/sdk";\nimport { b } from "./b";\nimport "node:fs";')).toEqual([]);
  });
});
