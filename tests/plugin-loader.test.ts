import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachineConfig } from "../src/machine";
import { parseWorkflowText } from "../src/engine/workflows";
import { isMissingPackage, loadPlugin, loadPlugins, startPlugins } from "../src/plugins/loader";
import { marketplaceProblems } from "../src/plugins/marketplace";
import { manifestProblems } from "../src/plugins/manifest";
import { agents, steps, trackers } from "../src/plugins/registry";

mkdirSync(tmpdir(), { recursive: true });
const root = mkdtempSync(join(tmpdir(), "plugins-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  steps.unregister("fake-loaded");
  agents.unregister("fake-loaded-agent");
});

const plugin = (name: string, manifest: object, code: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "index.ts"), code);
  return dir;
};

describe("manifest", () => {
  test.each([
    [{ kind: "step", entry: "i.ts" }, "plugin.json: name: expected"],
    [{ name: "x", kind: "widget", entry: "i.ts" }, "plugin.json: kind: expected one of agent, step, tracker"],
    [{ name: "x", kind: "step" }, "plugin.json: entry: expected a non-empty path"],
    [{ name: "x", kind: "step", entry: "../i.ts" }, "plugin.json: entry: expected a path inside"],
    [{ name: "x", kind: "step", entry: "i.ts", extra: 1 }, "plugin.json: extra: unknown key"],
  ])("rejects %j naming the field", (m, text) => {
    expect(manifestProblems(m).join("\n")).toContain(text);
  });
  test("accepts a valid manifest", () => {
    expect(manifestProblems({ name: "x", kind: "step", entry: "i.ts" })).toEqual([]);
  });
});

describe("loader", () => {
  test("loads a fake step plugin from a directory and the workflow parser uses it", async () => {
    const wf = "name: t\nsteps:\n  a:\n    uses: fake-loaded\n    label: x\n";
    expect(parseWorkflowText(wf).ok).toBe(false);
    plugin(
      "fake-loaded",
      { name: "fake-loaded", kind: "step", entry: "index.ts" },
      'export default { terminal: true, async run() { return { kind: "stop", outcome: "shipped" }; } };',
    );
    await loadPlugins(root, ["fake-loaded"]);
    expect(steps.sourceOf("fake-loaded")).toContain("plugin fake-loaded");
    expect(parseWorkflowText(wf).ok).toBe(true);
    await loadPlugins(root, ["fake-loaded"]);
  });

  test("an agent plugin lands in the agent registry", async () => {
    plugin(
      "fake-loaded-agent",
      { name: "fake-loaded-agent", kind: "agent", entry: "index.ts" },
      "export default { name: 'fake-loaded-agent' };",
    );
    await loadPlugins(root, ["fake-loaded-agent"]);
    expect(agents.get("fake-loaded-agent")?.name).toBe("fake-loaded-agent");
  });

  test("a tracker plugin must default-export a function", async () => {
    const dir = plugin("bad-tracker", { name: "bad-tracker", kind: "tracker", entry: "index.ts" }, "export default 1;");
    await expect(loadPlugin(dir)).rejects.toThrow("default-exports a function");
    expect(trackers.has("bad-tracker")).toBe(false);
  });

  test("an invalid manifest and a name that differs from its directory are refused", async () => {
    const dir = plugin("odd", { name: "other", kind: "step", entry: "index.ts" }, "export default {};");
    await expect(loadPlugin(dir, "odd")).rejects.toThrow('name: expected "odd" to match its directory');
    const bad = plugin("bad", { name: "bad", kind: "nope", entry: "index.ts" }, "");
    await expect(loadPlugin(bad)).rejects.toThrow("kind: expected one of");
  });
});

describe("machine config", () => {
  const env = (cfg: object) => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    writeFileSync(join(home, "machine.json"), JSON.stringify({ slots: 1, ...cfg }));
    return { FACTORY_HOME: home } as NodeJS.ProcessEnv;
  };
  test("the default enables no extra plugins", async () => {
    expect("plugins" in loadMachineConfig(env({}))).toBe(false);
    expect(await startPlugins({})).toEqual([]);
  });
  test("plugins.enabled is read and checked", () => {
    expect(loadMachineConfig(env({ plugins: { enabled: ["a-b"] } })).plugins).toEqual({ enabled: ["a-b"] });
    expect(() => loadMachineConfig(env({ plugins: { enabled: ["A B"] } }))).toThrow("plugins.enabled[0]");
  });
  test("startPlugins loads what the machine enables from FACTORY_HOME/plugins", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    const dir = join(home, "plugins", "from-home");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "from-home", kind: "tracker", entry: "i.ts" }));
    writeFileSync(join(dir, "i.ts"), "export default () => ({});");
    const loaded = await startPlugins({ plugins: { enabled: ["from-home"] } }, { FACTORY_HOME: home });
    expect(loaded.map((m) => m.name)).toEqual(["from-home"]);
    expect(trackers.has("from-home")).toBe(true);
    trackers.unregister("from-home");
  });
});

describe("marketplace schema", () => {
  const entry = { name: "p", kind: "agent", description: "d", version: "1.0.0", source: "https://example.com/p.tgz" };
  test("accepts a valid listing", () => {
    expect(marketplaceProblems({ plugins: [entry] })).toEqual([]);
  });
  test.each([
    [{ plugins: [{ ...entry, kind: "x" }] }, "plugins[0]: kind: expected one of"],
    [{ plugins: [{ ...entry, source: "http://x/p" }] }, "plugins[0]: source: expected an https URL"],
    [{ plugins: [{ ...entry, description: "" }] }, "plugins[0]: description"],
    [{ plugins: [entry, entry] }, 'plugins[1]: name: "p" is listed twice'],
    [{ plugins: "no" }, "plugins: expected a list"],
  ])("rejects %j", (m, text) => {
    expect(marketplaceProblems(m).join("\n")).toContain(text);
  });
});

describe("startup", () => {
  test("the factory binary loads enabled plugins before the CLI runs", async () => {
    const bin = await Bun.file(join(import.meta.dir, "..", "bin", "factory")).text();
    expect(bin.indexOf('import "../src/plugins/boot"')).toBeGreaterThan(-1);
    expect(bin.indexOf('import "../src/plugins/boot"')).toBeLessThan(bin.indexOf('import "../src/cli"'));
    const boot = await Bun.file(join(import.meta.dir, "..", "src", "plugins", "boot.ts")).text();
    expect(boot).toContain("await startPlugins(loadMachineConfig())");
  });
});

test("a missing optional package is told apart from a broken one, in all three shapes", () => {
  const name = "@kaas-team/factory-dashboard";
  expect(isMissingPackage(Object.assign(new Error("x"), { code: "ERR_MODULE_NOT_FOUND" }), name)).toBe(true);
  expect(isMissingPackage(new Error(`Cannot find package '${name}'`), name)).toBe(true);
  expect(isMissingPackage(new Error(`BuildMessage: ENOENT reading "/r/node_modules/${name}"`), name)).toBe(true);
  expect(isMissingPackage(new Error(`BuildMessage: ENOENT reading "/r/node_modules/other"`), name)).toBe(false);
  expect(isMissingPackage(new SyntaxError("Unexpected token"), name)).toBe(false);
});
