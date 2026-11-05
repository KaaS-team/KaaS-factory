import { afterEach, describe, expect, test } from "bun:test";
import { resolveAgentByName } from "../src/agents/executor";
import { PRESETS } from "../src/agents/presets";
import { claudePreset } from "../src/agents/presets/claude";
import { parseWorkflowText } from "../src/engine/workflows";
import { agents, type Registry, steps, trackers } from "../src/plugins/registry";
import { configProblems } from "../src/config";

const added: Array<[Registry<never>, string]> = [];
const reg = <T>(r: Registry<T>, name: string, entry: T, source?: string) => {
  r.register(name, entry, source);
  added.push([r as unknown as Registry<never>, name]);
};
afterEach(() => {
  for (const [r, n] of added.splice(0)) r.unregister(n);
});

const fakeAgent = { ...claudePreset, name: "fake-agent" };
const fakeStep = {
  terminal: true,
  async run() {
    return { kind: "stop", outcome: "shipped" } as const;
  },
};
const wf = (uses: string) => `name: t\nsteps:\n  a:\n    uses: ${uses}\n    label: x\n`;

describe("plugin registry", () => {
  test("a registered agent is found by core's agent lookup and config validation", () => {
    expect(() => resolveAgentByName({ a: { preset: "fake-agent" } }, "a", "build")).toThrow("unknown preset");
    expect(JSON.stringify(configProblems({ agents: { a: { preset: "fake-agent" } } }))).toContain("preset: unknown");
    reg(agents, "fake-agent", fakeAgent);
    expect(resolveAgentByName({ a: { preset: "fake-agent" } }, "a", "build").preset).toBe(fakeAgent);
    expect(PRESETS["fake-agent"]).toBe(fakeAgent);
    const problems = configProblems({ agents: { a: { preset: "fake-agent" } } });
    expect(JSON.stringify(problems)).not.toContain("unknown");
  });

  test("a registered step type is accepted by the workflow parser, an unregistered one is not", () => {
    expect(parseWorkflowText(wf("fake-step")).ok).toBe(false);
    reg(steps, "fake-step", fakeStep);
    expect(parseWorkflowText(wf("fake-step")).ok).toBe(true);
  });

  test("a registered tracker is looked up by name", () => {
    const make = (() => ({ id: "fake" })) as never;
    expect(trackers.has("fake-tracker")).toBe(false);
    reg(trackers, "fake-tracker", make);
    expect(trackers.get("fake-tracker")).toBe(make);
    expect(trackers.names()).toContain("fake-tracker");
  });

  test("registering a name twice fails and names both sources", () => {
    reg(agents, "dup", fakeAgent, "plugin alpha");
    expect(() => agents.register("dup", fakeAgent, "plugin beta")).toThrow(
      'agent "dup" is already registered by plugin alpha; plugin beta tried to register it again',
    );
    expect(() => steps.register("build", fakeStep, "plugin gamma")).toThrow("already registered by built in");
  });

  test("every shipped agent and step type is in its registry", () => {
    expect(agents.names()).toEqual(expect.arrayContaining(["claude", "codex", "acp"]));
    expect(steps.names()).toEqual(expect.arrayContaining(["triage", "plan", "build", "verify", "pr", "check", "tool"]));
  });
});
