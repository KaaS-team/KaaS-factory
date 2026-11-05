// #591: the lwpr runtime is a plugin. It registers through the registry, the core runs without it,
// and no core file imports it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const SRC = join(root, "src");
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : [],
  );

// Runs a snippet in a fresh process, since registration happens once per process.
function probe(code: string, env: Record<string, string> = {}): unknown {
  const out = Bun.spawnSync(["bun", "-e", code], { cwd: root, env: { ...process.env, ...env }, stderr: "pipe" });
  expect(out.stderr.toString()).toBe("");
  return JSON.parse(out.stdout.toString());
}

const SNIPPET = `
import { runtimes } from "./src/plugins/registry";
import { runtimeSpecs, runtimeProblems, runtimesFrom, runtimeKinds } from "./src/runtimes";
const ports = runtimesFrom({}, { ...process.env, FACTORY_HOME: "/tmp/runtime-plugin-probe" });
console.log(JSON.stringify({
  registered: runtimes.names(),
  specs: Object.keys(runtimeSpecs()),
  ports: Object.keys(ports),
  kinds: runtimeKinds(),
  problems: runtimeProblems({ box: { kind: "lwpr" } }),
}));`;

describe("the lwpr runtime is a plugin", () => {
  test("it registers through the registry and is a built-in runtime", () => {
    const r = probe(SNIPPET) as Record<string, string[]>;
    expect(r.registered).toEqual(["lwpr"]);
    expect(r.specs).toEqual(expect.arrayContaining(["default", "local", "lwpr"]));
    expect(r.ports).toEqual(expect.arrayContaining(["local", "lwpr"]));
    expect(r.problems).toEqual([]);
  });

  test("with the plugin disabled the core starts with local only, and lwpr is not a runtime kind", () => {
    const r = probe(SNIPPET, { FACTORY_DISABLE_PLUGINS: "lwpr" }) as Record<string, string[]>;
    expect(r.registered).toEqual([]);
    expect(r.specs).toEqual(expect.arrayContaining(["default", "local"]));
    expect(r.specs).not.toContain("lwpr");
    expect(r.ports).not.toContain("lwpr");
    expect(r.kinds).not.toContain("lwpr");
    expect((r.problems ?? []).join("\n")).toContain("runtimes.box.kind: one of");
  });

  test("no core file imports the plugin except the one loader", () => {
    const bad = walk(SRC)
      .filter((f) => !f.endsWith("/src/runtimes-shipped.ts"))
      .filter((f) => /(?:from|import)\s*\(?\s*"[^"]*contrib\/runtimes\//.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f));
    expect(bad).toEqual([]);
  });
});
