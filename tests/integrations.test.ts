// The connectors catalogue, walked whole: every manifest is valid and points at real files, every
// tracker and runtime kind the runner builds has one, and docs/integrations.md's table is generated.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KINDS, loadManifests, manifestProblems, renderIntegrationsDoc } from "../src/integrations/catalogue";
import { LIVE_RUNTIMES } from "./live/runtimes";
import { LIVE_TRACKERS } from "./live/trackers";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const manifests = loadManifests();
const byKind = (k: string) => manifests.filter((m) => m.kind === k);
// The names a switch builds, read from its source so a new case cannot skip its manifest.
const casesIn = (file: string, fn: string) => {
  const body = read(file).split(`function ${fn}(`)[1]!.split("\n}\n")[0]!;
  return [...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]!).sort();
};

describe("integration manifests", () => {
  test("every integration has a valid manifest whose contract test names each env key", () => {
    expect(manifests.length).toBeGreaterThan(20);
    for (const m of manifests) {
      const contract = read(m.contract);
      expect({ m: m.name, missing: m.env.filter((k) => !contract.includes(k)) }).toEqual({ m: m.name, missing: [] });
      expect(contract).toMatch(/\btest\(|\bContract\(/);
    }
    expect(new Set(manifests.map((m) => m.kind))).toEqual(new Set(KINDS));
  });

  test("a manifest with a wrong kind, a lowercase env name or a missing contract is refused", () => {
    const good = { name: "x", kind: "tracker", summary: "s", enable: "e", env: [], default: false } as const;
    const ok = { ...good, module: "src/x.ts", contract: "tests/x.test.ts" };
    expect(manifestProblems(ok, "x", () => true)).toEqual([]);
    expect(manifestProblems({ ...ok, kind: "crm" as never }, "x", () => true).join()).toMatch(/kind must be/);
    expect(manifestProblems({ ...ok, env: ["token"] }, "x", () => true).join()).toMatch(/not an env var name/);
    expect(manifestProblems(ok, "x", (p) => p !== ok.contract).join()).toMatch(/contract tests\/x\.test\.ts/);
    expect(manifestProblems(ok, "y", () => true).join()).toMatch(/name must be "y"/);
  });

  test("every tracker and runtime kind the runner builds has a manifest", () => {
    const kindOf = (m: (typeof manifests)[number]) => m.configKind ?? m.name;
    expect(byKind("tracker").map(kindOf).sort()).toEqual(casesIn("src/scm.ts", "makeTracker"));
    expect(byKind("runtime").map(kindOf).sort()).toEqual(
      [...casesIn("src/runtimes.ts", "executionFor"), "pool"].sort(),
    );
  });

  test("A2A and AG-UI are off unless a user turns them on", () => {
    const off = manifests.filter((m) => m.name === "a2a" || m.name === "ag-ui");
    expect(off.map((m) => [m.name, m.default])).toEqual([
      ["a2a", false],
      ["ag-ui", false],
    ]);
  });
});

describe("connectors catalogue", () => {
  test("docs/integrations.md's generated table equals the manifests", () => {
    const doc = read("docs/integrations.md");
    expect(doc).toBe(renderIntegrationsDoc(doc, manifests));
    for (const m of manifests) expect(doc).toContain(`| \`${m.name}\` | ${m.kind} |`);
  });
});

describe("live suites", () => {
  test("every tracker and runtime with a live block runs in its live suite, keyed by the manifest", () => {
    const live = (kind: string) =>
      Object.fromEntries(byKind(kind).flatMap((m) => (m.live ? [[m.name, [...m.live.env]]] : [])));
    const keys = (suite: Record<string, { env: readonly string[] }>) =>
      Object.fromEntries(Object.entries(suite).map(([k, v]) => [k, [...v.env]]));
    expect(keys(LIVE_TRACKERS)).toEqual(live("tracker"));
    expect(keys(LIVE_RUNTIMES)).toEqual(live("runtime"));
    expect(Object.keys(LIVE_TRACKERS).sort()).toEqual(["asana", "clickup", "jira", "linear", "plane"]);
    expect(Object.keys(LIVE_RUNTIMES).sort()).toEqual(["http-sandbox", "ssh", "wrap"]);
  });
});
