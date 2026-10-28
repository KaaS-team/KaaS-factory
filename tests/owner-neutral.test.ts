import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OWNER = new RegExp(["learn", "withparam"].join(""), "i");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? files(full) : [full];
  });
}

// Shipped code only: a stranger who installs the factory must never see another owner's name.
test("no file under src/ or template/ names the owner", () => {
  const hits = ["src", "template"].flatMap((d) =>
    files(join(ROOT, d)).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (OWNER.test(line) ? [`${f.slice(ROOT.length + 1)}:${i + 1}`] : [])),
    ),
  );
  expect(hits).toEqual([]);
});
