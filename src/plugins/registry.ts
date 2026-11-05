// One registry per plugin kind. Agents, step types and trackers register here by name and core code
// looks them up by name; it imports no specific one. Registering a name twice throws and names both
// sources, so two plugins never silently shadow each other.

import type { AgentPreset } from "../agents/types";
import type { StepType } from "../engine/steps";
import type { ExecutionPort } from "../ports/execution";
import type { SandboxCapabilities } from "../ports/sandbox";
import type { TrackerPort } from "../ports/scm";

export type PluginKind = "agent" | "step" | "tracker" | "runtime";
export const PLUGIN_KINDS: readonly PluginKind[] = ["agent", "step", "tracker", "runtime"];

export class Registry<T> {
  // The live table. Callers that index by name (`PRESETS[name]`) read this object, so a later
  // registration is visible to them without a second copy.
  readonly table: Record<string, T> = Object.create(null);
  private readonly sources = new Map<string, string>();

  constructor(readonly kind: PluginKind) {}

  register(name: string, entry: T, source = "built in"): void {
    if (!name) throw new Error(`${this.kind}: cannot register an empty name`);
    const prior = this.sources.get(name);
    if (prior !== undefined)
      throw new Error(`${this.kind} "${name}" is already registered by ${prior}; ${source} tried to register it again`);
    this.table[name] = entry;
    this.sources.set(name, source);
  }

  get(name: string): T | undefined {
    return this.table[name];
  }

  has(name: string): boolean {
    return this.sources.has(name);
  }

  names(): string[] {
    return [...this.sources.keys()];
  }

  sourceOf(name: string): string | undefined {
    return this.sources.get(name);
  }

  // Test hook: removes one entry so a fake can be registered and cleaned up.
  unregister(name: string): void {
    this.sources.delete(name);
    delete this.table[name];
  }
}

// Builds a tracker from its config block and the environment.
export type TrackerFactory = (config: never, env: Record<string, string | undefined>) => TrackerPort;

export const agents = new Registry<AgentPreset>("agent");
export const steps = new Registry<StepType>("step");
export const trackers = new Registry<TrackerFactory>("tracker");

// A runtime kind: the machine.json fields it accepts, what its sandbox can do, and how to run on it.
// `builtin` also makes the kind's own name a runtime with an empty spec, as `local` is.
export interface RuntimePlugin {
  readonly shape: {
    readonly required: readonly string[];
    readonly fields: Readonly<Record<string, "string" | "posInt" | "boolean" | "strings">>;
  };
  readonly capabilities: SandboxCapabilities;
  readonly builtin?: boolean;
  create(spec: never): ExecutionPort;
}

export const runtimes = new Registry<RuntimePlugin>("runtime");
