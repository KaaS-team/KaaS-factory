// The core is Apache-2.0, ee/ is under the KaaS Factory Enterprise License, ported files keep their
// upstream licence and the brand is not licensed at all. REUSE.toml says which file is which;
// `reuse lint` (make lint) checks it against the spec, these tests check it says what we decided.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { unsigned } from "../scripts/dco";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
interface Annotation {
  path: string | string[];
  precedence: string;
  "SPDX-License-Identifier": string;
}
const reuse = Bun.TOML.parse(read("REUSE.toml")) as { annotations: Annotation[] };
const paths = (a: Annotation) => (Array.isArray(a.path) ? a.path : [a.path]);
// The override that decides a file's licence, or the `**` default when none names it.
function licenceOf(file: string): string {
  const hit = reuse.annotations.find((a) => a.precedence === "override" && paths(a).some((p) => matches(p, file)));
  return (hit ?? reuse.annotations.find((a) => paths(a).includes("**"))!)["SPDX-License-Identifier"];
}
function matches(glob: string, file: string): boolean {
  return glob.endsWith("/**") ? file.startsWith(glob.slice(0, -2)) : glob === file;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (["node_modules", "target"].includes(name) || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? walk(path) : [relative(root, path)];
  });
}
const files = walk(root);

test("the core is Apache-2.0 and ee/ is under the enterprise licence", () => {
  expect(licenceOf("src/cli.ts")).toBe("Apache-2.0");
  expect(licenceOf("ee/README.md")).toBe("LicenseRef-KaaS-EE");
  expect(read("LICENSE").endsWith(read("LICENSES/Apache-2.0.txt"))).toBe(true);
  expect(read("LICENSE")).toContain('All content under the "ee/" directory is licensed under the KaaS Factory');
  expect(read("ee/LICENSE")).toBe(read("LICENSES/LicenseRef-KaaS-EE.txt"));
  expect(JSON.parse(read("package.json")).license).toBe("Apache-2.0");
  for (const crate of ["verify", "relay"]) expect(read(`${crate}/Cargo.toml`)).toContain('license = "Apache-2.0"');
});

test("every licence REUSE.toml names has its text, and no text goes unused", () => {
  const ids = new Set(reuse.annotations.flatMap((a) => a["SPDX-License-Identifier"].split(/ AND | OR /)));
  const texts = readdirSync(join(root, "LICENSES")).map((f) => f.replace(/\.txt$/, ""));
  expect(texts.sort()).toEqual([...ids].sort());
});

test("every ported file keeps its upstream licence", () => {
  const ported = files.filter((f) => /\.(ts|js|css|md)$/.test(f));
  for (const f of ported) {
    const head = read(f).split("\n").slice(0, 8).join("\n");
    if (!/^(?:\/\/|\/\*|<!--) Ported from /m.test(head)) continue;
    const want = head.includes("(MIT, Copyright (c) 2026 Owain Lewis)") ? "MIT AND Apache-2.0" : "Apache-2.0";
    expect(`${f}: ${licenceOf(f)}`).toBe(`${f}: ${want}`);
    if (want === "Apache-2.0")
      expect(
        reuse.annotations.some((a) => paths(a).includes(f)),
        f,
      ).toBe(true);
  }
  for (const a of reuse.annotations.filter((x) => x["SPDX-License-Identifier"] === "MIT AND Apache-2.0"))
    for (const f of paths(a)) expect(read(f).split("\n").slice(0, 8).join("\n"), f).toContain("Ported from ");
});

test("design components: tokens are ours, ported CSS stays MIT, Geist stays OFL", () => {
  expect(licenceOf("dashboard/public/tokens.css")).toBe("Apache-2.0");
  expect(licenceOf("dashboard/public/styles.css")).toBe("MIT AND Apache-2.0");
  expect(licenceOf("dashboard/public/fonts/geist.woff2")).toBe("OFL-1.1");
});

test("the brand is not licensed, and forks are told to replace it", () => {
  expect(licenceOf("dashboard/public/icon.svg")).toBe("LicenseRef-KaaS-Brand");
  expect(read("TRADEMARKS.md")).toContain("replace `dashboard/public/icon.svg`");
});

// The core must build without ee/, so an import into it from anywhere else is the boundary broken.
// This file is skipped: its own examples below are the only allowed mention.
const CROSSES = /(?:from|import|require)\s*\(?\s*["'](?:\.{1,2}\/)+(?:[\w.-]+\/)*ee(?:\/|["'])/;
test("nothing outside ee/ imports from ee/", () => {
  expect(CROSSES.test('import { sso } from "../ee/sso";')).toBe(true);
  expect(CROSSES.test('const x = await import("../../ee/scim.ts");')).toBe(true);
  const crossing = files
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.startsWith("ee/") && f !== "tests/licensing.test.ts")
    .filter((f) => CROSSES.test(read(f)));
  expect(crossing).toEqual([]);
});

test("a commit needs a sign-off from its own author", () => {
  const signed = { sha: "a", email: "dev@x.io", body: "fix\n\nSigned-off-by: Dev <dev@x.io>\n" };
  const missing = { sha: "b", email: "dev@x.io", body: "fix\n" };
  const someoneElse = { sha: "c", email: "dev@x.io", body: "fix\n\nSigned-off-by: Other <other@x.io>\n" };
  const quoted = { sha: "d", email: "dev@x.io", body: "fix: mention Signed-off-by: Dev <dev@x.io> inline\n" };
  const bot = { sha: "e", email: "49699333+dependabot[bot]@users.noreply.github.com", body: "bump\n" };
  expect(unsigned([signed, missing, someoneElse, quoted, bot]).map((c) => c.sha)).toEqual(["b", "c", "d"]);
});

test("ci runs the DCO check on pull requests", () => {
  expect(read(".github/workflows/ci.yml")).toContain("bun scripts/dco.ts");
  expect(existsSync(join(root, "CONTRIBUTING.md"))).toBe(true);
});

// The default install is open source end to end and small: no runtime npm package at all, and
// every Rust crate under an OSI licence. A runtime dependency is a decision, so it edits this test.
const OPEN = new Set(["MIT", "Apache-2.0", "LLVM-exception", "BSD-1-Clause", "BSD-2-Clause", "BSD-3-Clause"]);
for (const id of ["ISC", "Unicode-3.0", "BSL-1.0", "Unlicense", "Zlib", "0BSD", "CC0-1.0"]) OPEN.add(id);
test("the core runs on open source only, with no runtime npm package", () => {
  expect(JSON.parse(read("package.json")).dependencies ?? {}).toEqual({});
  for (const crate of ["verify", "relay"]) {
    const out = Bun.spawnSync(
      ["cargo", "metadata", "--format-version", "1", "--locked", "--manifest-path", `${crate}/Cargo.toml`],
      { cwd: root },
    );
    expect(out.exitCode).toBe(0);
    for (const p of JSON.parse(out.stdout.toString()).packages as { name: string; license: string | null }[]) {
      const ids = (p.license ?? "NONE").split(/\s+(?:AND|OR|WITH)\s+|[()/]/).filter(Boolean);
      expect(`${p.name}: ${ids.filter((id) => !OPEN.has(id)).join(" ")}`).toBe(`${p.name}: `);
    }
  }
});
