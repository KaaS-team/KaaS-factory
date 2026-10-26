// The sandbox contract (docs/runtimes.md#the-sandbox-contract): what any place a step runs offers
// beyond ExecutionPort's one `run`. A runtime that cannot do a verb says so in its capability
// flags, and the verb throws SandboxUnsupported instead of pretending.

import type { ExecResult } from "./execution";

export interface SandboxCapabilities {
  // What stands between the command and this machine; "unknown" when a launcher or vendor decides.
  readonly isolation: "none" | "container" | "microvm" | "remote" | "unknown";
  // Bring your own: the sandbox is a host or account the user already runs, not one we create.
  readonly byo: boolean;
  readonly snapshot: boolean;
  // pause then resume keeps processes and memory, not only files.
  readonly memoryResume: boolean;
  readonly expose: boolean;
  // "deny": no network unless allowed; "open": the host's network; "provider": the vendor decides.
  readonly egress: "deny" | "open" | "provider";
}

export interface SandboxCreate {
  // Files to start from: a snapshot id this provider returned, or nothing for an empty workdir.
  readonly snapshot?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly ttlSec?: number;
}

export type SandboxStatus = "running" | "paused" | "destroyed";

export interface Sandbox {
  readonly id: string;
  exec(cmd: string, signal?: AbortSignal): Promise<ExecResult>;
  readonly files: {
    put(path: string, data: string | Uint8Array): Promise<void>;
    get(path: string): Promise<Uint8Array>;
    list(dir?: string): Promise<string[]>;
  };
  snapshot(): Promise<string>;
  pause(): Promise<{ readonly memoryKept: boolean }>;
  resume(): Promise<void>;
  expose(port: number): Promise<string>;
  status(): Promise<SandboxStatus>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly capabilities: SandboxCapabilities;
  create(opts?: SandboxCreate): Promise<Sandbox>;
}

export class SandboxUnsupported extends Error {}
